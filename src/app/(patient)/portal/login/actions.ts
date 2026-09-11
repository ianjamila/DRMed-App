"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyPin } from "@/lib/auth/pin";
import { mintPatientSession } from "@/lib/auth/patient-session";
import {
  clearPatientSessionCookie,
  setPatientSessionCookie,
} from "@/lib/auth/patient-session-cookies";
import { audit } from "@/lib/audit/log";
import { PatientSignInSchema } from "@/lib/validations/auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { selectActivePins, type VisitPinCandidate } from "@/lib/auth/pin-selection";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const GENERIC_ERROR =
  "Invalid DRM-ID or PIN. If you've lost your receipt, please visit reception for a new PIN.";
const LOCKED_ERROR = `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`;

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function signInPatient(
  _prevState: SignInResult | null,
  formData: FormData,
): Promise<SignInResult> {
  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  // IP-level rate limit before any DB work. visit_pins.failed_attempts
  // already locks individual PINs after 5 failures; this catches an
  // attacker sweeping DRM-IDs from a single IP.
  if (ipAddress) {
    const limit = await checkRateLimit({
      bucket: "patient_pin",
      identifier: ipAddress,
      ...RATE_LIMITS.patient_pin,
    });
    if (!limit.allowed) {
      await audit({
        actor_id: null,
        actor_type: "anonymous",
        action: "patient.signin.rate_limited",
        metadata: { retry_after_sec: limit.retryAfterSec },
        ip_address: ipAddress,
        user_agent: userAgent,
      });
      return {
        ok: false,
        error: `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.`,
      };
    }
  }

  const parsed = PatientSignInSchema.safeParse({
    drm_id: formData.get("drm_id"),
    pin: formData.get("pin"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? GENERIC_ERROR,
    };
  }

  const { drm_id, pin } = parsed.data;
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // 1) Patient lookup.
  const { data: patient } = await admin
    .from("patients")
    .select("id, drm_id")
    .eq("drm_id", drm_id)
    .maybeSingle();

  if (!patient) {
    await audit({
      actor_id: null,
      actor_type: "anonymous",
      action: "patient.signin.failed",
      metadata: { drm_id, reason: "patient_not_found" },
      ip_address: ipAddress,
      user_agent: userAgent,
    });
    return { ok: false, error: GENERIC_ERROR };
  }

  // 2) Every unexpired PIN across the patient's visits (N9). A repeat
  // patient can legitimately hold more than one still-valid PIN at once — a
  // new visit always mints a fresh one without expiring an earlier one still
  // inside its 60-day window, and re-issuing rewrites a row's hash without
  // touching created_at. Accepting only the newest row meant a
  // correctly-printed PIN from an earlier receipt could silently stop
  // working. selectActivePins() applies the per-row lockout gate; every
  // active row is checked below.
  const { data: pins } = await admin
    .from("visit_pins")
    .select(
      "id, visit_id, pin_hash, failed_attempts, locked_until, created_at, visits!inner(patient_id)",
    )
    .eq("visits.patient_id", patient.id)
    .gt("expires_at", nowIso);

  const pinRows: VisitPinCandidate[] = pins ?? [];

  if (pinRows.length === 0) {
    await audit({
      actor_id: null,
      actor_type: "patient",
      patient_id: patient.id,
      action: "patient.signin.failed",
      metadata: { drm_id, reason: "no_active_pin" },
      ip_address: ipAddress,
      user_agent: userAgent,
    });
    return { ok: false, error: GENERIC_ERROR };
  }

  // 3) Lockout check — same gate as before, now applied per candidate row.
  // If every unexpired PIN is currently locked out, reject without running
  // any bcrypt comparison at all, exactly as the single-PIN version did.
  const { active, allLocked } = selectActivePins(pinRows, Date.now());

  if (allLocked) {
    await audit({
      actor_id: null,
      actor_type: "patient",
      patient_id: patient.id,
      action: "patient.signin.locked_attempt",
      metadata: { drm_id },
      ip_address: ipAddress,
      user_agent: userAgent,
    });
    return { ok: false, error: LOCKED_ERROR };
  }

  // 4) Compare the submitted PIN against every active candidate, stopping at
  // the first match. Each row's hash is for a distinct, independently
  // generated PIN, so at most one can genuinely match; the response and
  // audit trail never reveal how many candidates were tried, only whether
  // sign-in succeeded, failed, or is locked — same three outcomes as before.
  let matchedPin: VisitPinCandidate | null = null;
  for (const candidate of active) {
    if (await verifyPin(pin, candidate.pin_hash)) {
      matchedPin = candidate;
      break;
    }
  }

  if (!matchedPin) {
    // Bump every active candidate's counter together, not just one. This
    // keeps the attacker's total guess budget identical to the single-PIN
    // case (5 attempts, 15-minute lockout) regardless of how many valid
    // PINs the patient happens to hold — a wrong guess is a wrong guess
    // against all of them, so extra valid PINs never grant extra attempts.
    let anyStillUnlocked = false;
    for (const candidate of active) {
      const nextAttempts = candidate.failed_attempts + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
      if (!shouldLock) anyStillUnlocked = true;
      await admin
        .from("visit_pins")
        .update({
          failed_attempts: nextAttempts,
          locked_until: shouldLock
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
            : null,
        })
        .eq("id", candidate.id);
    }

    await audit({
      actor_id: null,
      actor_type: "patient",
      patient_id: patient.id,
      action: anyStillUnlocked ? "patient.signin.failed" : "patient.signin.locked",
      // candidate_count is audit-only (staff-facing, never returned to the
      // caller) — it doesn't weaken the "no oracle" guarantee on the
      // patient-facing response, which stays one of the same three
      // messages regardless of how many PINs exist.
      metadata: { drm_id, candidate_count: active.length },
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    return {
      ok: false,
      error: anyStillUnlocked ? GENERIC_ERROR : LOCKED_ERROR,
    };
  }

  // 5) Success: reset ONLY the matched row's counters — never every active
  // candidate. Resetting the others too would silently undo a legitimate
  // lockout on a different still-valid PIN (e.g. one an attacker has been
  // guessing against) the moment the patient signs in with a different one.
  await admin
    .from("visit_pins")
    .update({
      failed_attempts: 0,
      locked_until: null,
      last_used_at: nowIso,
    })
    .eq("id", matchedPin.id);

  const token = await mintPatientSession({
    patient_id: patient.id,
    drm_id: patient.drm_id,
    visit_id: matchedPin.visit_id,
  });
  await setPatientSessionCookie(token);

  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: patient.id,
    action: "patient.signin.success",
    metadata: { drm_id, visit_id: matchedPin.visit_id },
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  redirect("/portal");
}

export async function signOutPatient() {
  await clearPatientSessionCookie();
  redirect("/portal/login");
}
