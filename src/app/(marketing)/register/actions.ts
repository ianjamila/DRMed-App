"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";
import { resolvePatient } from "@/lib/patients/resolve";
import { findCandidatesForInput } from "@/lib/patients/find-duplicates";
import { sendEmail } from "@/lib/notifications/email";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";
import { RegistrationSchema } from "@/lib/validations/registration";
import { SITE } from "@/lib/marketing/site";
import {
  renderEmailShell, emailParagraph, emailHighlight, emailButton, escapeHtml,
} from "@/lib/notifications/branded-email";

export type RegistrationResult =
  | { ok: true; matched: false; drm_id: string }
  | { ok: true; matched: true }
  | { ok: false; error: string };

// Honeypot trip looks like a generic success so bots get no signal.
const HONEYPOT_OK: RegistrationResult = { ok: true, matched: true };

export async function submitRegistrationAction(
  _prev: RegistrationResult | null,
  formData: FormData,
): Promise<RegistrationResult> {
  if ((formData.get("website") ?? "") !== "") return HONEYPOT_OK;

  const { ip, ua } = await ipAndAgent();

  if (ip) {
    const limit = await checkRateLimit({ bucket: "patient_registration", identifier: ip, ...RATE_LIMITS.patient_registration });
    if (!limit.allowed) {
      return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or visit reception.` };
    }
  } else {
    // M10: the limit was silently skipped — make the fail-open loud so a
    // proxy/header misconfiguration can't quietly disable rate-limiting.
    void reportError({
      scope: "rate-limit/no-client-ip",
      error: new Error("x-forwarded-for missing"),
      metadata: { bucket: "patient_registration" },
    });
  }

  const parsed = RegistrationSchema.safeParse({
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    middle_name: formData.get("middle_name") ?? "",
    birthdate: formData.get("birthdate"),
    sex: formData.get("sex") ?? "",
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address") ?? "",
    data_privacy_consent: formData.get("data_privacy_consent") ?? "",
    marketing_consent: formData.get("marketing_consent") ?? "off",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;

  const admin = createAdminClient();

  // M4: fuzzy dedup before the exact-triple resolve. A strong/exact near-match
  // (e.g. same person, new email) is treated like the matched branch below:
  // email the DRM-ID to the CANDIDATE's on-file address — never the supplied
  // one, and never on screen (enumeration safety) — and create no new row and
  // no consent row. probable/weak proceed to resolvePatient (itself
  // advisory-locked since 0112).
  const candidates = await findCandidatesForInput(admin, {
    first_name: d.first_name,
    last_name: d.last_name,
    birthdate: d.birthdate,
    email: d.email,
    phone_normalized: (d.phone ?? "").replace(/\D/g, "").slice(-10) || null,
    address: d.address,
    sex: d.sex,
  }, { minTier: "strong" });
  const match = candidates[0];
  if (match) {
    const onFileEmail = match.patient.email;
    const sendResult = onFileEmail
      ? await sendEmail({
          to: onFileEmail,
          subject: "Your DRMed DRM-ID",
          text: `Hi ${match.patient.first_name},\n\nWe found an existing DRMed record matching your details. Your DRM-ID is ${match.patient.drm_id}.\n\nPresent it at the clinic. After your visit, the Secure PIN printed on your receipt unlocks your results online.\n\n— DRMed Clinic and Laboratory`,
          html: renderEmailShell({
            heading: "Your DRMed patient ID",
            contentHtml:
              emailParagraph(`Hi <b>${escapeHtml(match.patient.first_name)}</b>,`) +
              emailParagraph("We found an existing DRMed record matching your details. Here is your patient ID:") +
              emailHighlight("Your DRM-ID", match.patient.drm_id) +
              emailParagraph("Present it at the clinic. After your visit, the Secure PIN printed on your receipt unlocks your results online."),
          }),
        })
      : null;
    await audit({
      actor_id: null,
      actor_type: "anonymous",
      patient_id: match.patient.id,
      action: "patient.self_register.matched",
      resource_type: "patient",
      resource_id: match.patient.id,
      metadata: {
        drm_id: match.patient.drm_id,
        via: "register",
        dedup_tier: match.score.tier,
        email: !sendResult
          ? { ok: false, skipped: true, reason: "no on-file email" }
          : sendResult.ok
            ? { ok: true, id: sendResult.id, to: onFileEmail }
            : sendResult.kind === "skipped"
              ? { ok: false, skipped: true, reason: sendResult.reason }
              : { ok: false, error: sendResult.error, to: onFileEmail },
      },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: true, matched: true };
  }

  const res = await resolvePatient(admin, {
    first_name: d.first_name,
    last_name: d.last_name,
    middle_name: d.middle_name,
    birthdate: d.birthdate,
    sex: d.sex,
    phone: d.phone,
    email: d.email,
    address: d.address,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Dedup match: do NOT reveal the DRM-ID on a public page (enumeration safety).
  // Email it to the on-file address — which equals the supplied email, since the
  // dedup matched on lower(email)+last_name+birthdate. No consent write: a public
  // form must not re-affirm an existing patient's consent state.
  if (res.reused) {
    const sendResult = await sendEmail({
      to: d.email,
      subject: "Your DRMed DRM-ID",
      text: `Hi ${d.first_name},\n\nWe found an existing DRMed record matching your details. Your DRM-ID is ${res.drm_id}.\n\nPresent it at the clinic. After your visit, the Secure PIN printed on your receipt unlocks your results online.\n\n— DRMed Clinic and Laboratory`,
      html: renderEmailShell({
        heading: "Your DRMed patient ID",
        contentHtml:
          emailParagraph(`Hi <b>${escapeHtml(d.first_name)}</b>,`) +
          emailParagraph("We found an existing DRMed record matching your details. Here is your patient ID:") +
          emailHighlight("Your DRM-ID", res.drm_id) +
          emailParagraph("Present it at the clinic. After your visit, the Secure PIN printed on your receipt unlocks your results online."),
      }),
    });
    await audit({
      actor_id: null,
      actor_type: "anonymous",
      patient_id: res.id,
      action: "patient.self_register.matched",
      resource_type: "patient",
      resource_id: res.id,
      metadata: {
        drm_id: res.drm_id,
        via: "register",
        email: sendResult.ok
          ? { ok: true, id: sendResult.id, to: d.email }
          : sendResult.kind === "skipped"
            ? { ok: false, skipped: true, reason: sendResult.reason }
            : { ok: false, error: sendResult.error, to: d.email },
      },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: true, matched: true };
  }

  // Server-side RA-10173 gate: never record a consent row (or finish the
  // registration) unless data-privacy consent was actually given. The schema
  // already refines on this, but we re-check the parsed boolean explicitly so
  // a future schema change can't silently let an unconsented patient through.
  if (!d.data_privacy_consent) {
    return { ok: false, error: "Please accept the data-privacy consent to register." };
  }

  // New registrant: record the RA-10173 consent the form required (the
  // sync_patient_consent_state trigger flips patients.consent_current = true),
  // then email + show the DRM-ID.
  await admin.from("patient_consents").insert({
    patient_id: res.id,
    event_type: "granted",
    method: "self_registration",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: "self",
    actor_kind: "patient",
    ip,
    user_agent: ua,
  });

  // Optional marketing opt-in. Mirror the schedule form's subscribe: insert a
  // fresh subscriber, or re-consent a previously-unsubscribed one, preserving
  // first-touch `source`.
  if (d.marketing_consent) {
    const lower = d.email.trim().toLowerCase();
    const { data: existing } = await admin.from("subscribers").select("id, unsubscribed_at").eq("email", lower).maybeSingle();
    if (!existing) {
      await admin.from("subscribers").insert({ email: lower, source: "register", consent_ip: ip });
    } else if (existing.unsubscribed_at !== null) {
      await admin.from("subscribers").update({ unsubscribed_at: null, consent_at: new Date().toISOString(), consent_ip: ip }).eq("id", existing.id);
    }
  }

  const welcomeResult = await sendEmail({
    to: d.email,
    subject: "Welcome to DRMed — your DRM-ID",
    text: `Hi ${d.first_name},\n\nThanks for pre-registering. Your DRM-ID is ${res.drm_id}.\n\nBring it on your visit — reception verifies your identity at the counter. After your visit, the Secure PIN printed on your receipt unlocks your results online.\n\n— DRMed Clinic and Laboratory`,
    html: renderEmailShell({
      heading: "Welcome to DRMed",
      contentHtml:
        emailParagraph(`Hi <b>${escapeHtml(d.first_name)}</b>,`) +
        emailParagraph("Thanks for pre-registering. This is your DRMed patient ID — present it at the clinic on your visit:") +
        emailHighlight("Your DRM-ID", res.drm_id) +
        emailParagraph("Reception verifies your identity at the counter. After your visit, the Secure PIN printed on your receipt unlocks your results online.") +
        emailButton("Book an appointment", `${SITE.url.replace(/\/$/, "")}/schedule`, "cyan"),
    }),
  });

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: res.id,
    action: "patient.self_registered",
    resource_type: "patient",
    resource_id: res.id,
    metadata: {
      drm_id: res.drm_id,
      via: "register",
      consent_recorded: true,
      marketing_consent: d.marketing_consent,
      email: welcomeResult.ok
        ? { ok: true, id: welcomeResult.id, to: d.email }
        : welcomeResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: welcomeResult.reason }
          : { ok: false, error: welcomeResult.error, to: d.email },
    },
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true, matched: false, drm_id: res.drm_id };
}
