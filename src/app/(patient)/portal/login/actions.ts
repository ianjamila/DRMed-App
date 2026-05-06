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

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const GENERIC_ERROR = "Invalid DRM-ID or PIN.";
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

  // 2) Latest unexpired pin across the patient's visits.
  const { data: pins } = await admin
    .from("visit_pins")
    .select(
      "id, visit_id, pin_hash, failed_attempts, locked_until, visits!inner(patient_id)",
    )
    .eq("visits.patient_id", patient.id)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);

  const pinRow = pins?.[0];

  if (!pinRow) {
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

  // 3) Lockout check.
  const lockedUntilMs = pinRow.locked_until
    ? new Date(pinRow.locked_until).getTime()
    : 0;
  if (lockedUntilMs > Date.now()) {
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

  // 4) Compare PIN.
  const matched = await verifyPin(pin, pinRow.pin_hash);

  if (!matched) {
    const nextAttempts = pinRow.failed_attempts + 1;
    const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;

    await admin
      .from("visit_pins")
      .update({
        failed_attempts: nextAttempts,
        locked_until: shouldLock
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
          : null,
      })
      .eq("id", pinRow.id);

    await audit({
      actor_id: null,
      actor_type: "patient",
      patient_id: patient.id,
      action: shouldLock ? "patient.signin.locked" : "patient.signin.failed",
      metadata: { drm_id, failed_attempts: nextAttempts },
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    return {
      ok: false,
      error: shouldLock ? LOCKED_ERROR : GENERIC_ERROR,
    };
  }

  // 5) Success: reset counters, mint session, redirect.
  await admin
    .from("visit_pins")
    .update({
      failed_attempts: 0,
      locked_until: null,
      last_used_at: nowIso,
    })
    .eq("id", pinRow.id);

  const token = await mintPatientSession({
    patient_id: patient.id,
    drm_id: patient.drm_id,
    visit_id: pinRow.visit_id,
  });
  await setPatientSessionCookie(token);

  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: patient.id,
    action: "patient.signin.success",
    metadata: { drm_id, visit_id: pinRow.visit_id },
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  redirect("/portal");
}

export async function signOutPatient() {
  await clearPatientSessionCookie();
  redirect("/portal/login");
}
