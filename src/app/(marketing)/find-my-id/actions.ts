"use server";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailHighlight, escapeHtml } from "@/lib/notifications/branded-email";
import { RecoverIdSchema } from "./schema";

// Always returns the same neutral response — never reveals whether a record
// matched (enumeration safety).
export type RecoverResult = { ok: true } | { ok: false; error: string };

const NEUTRAL: RecoverResult = { ok: true };

export async function recoverDrmIdAction(_prev: RecoverResult | null, formData: FormData): Promise<RecoverResult> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = h.get("user-agent");

  const limit = await checkRateLimit({ bucket: "patient_id_recovery", identifier: ip, ...RATE_LIMITS.patient_id_recovery });
  if (!limit.allowed) {
    return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.` };
  }

  const parsed = RecoverIdSchema.safeParse({
    last_name: formData.get("last_name"),
    email: formData.get("email"),
    birthdate: formData.get("birthdate"),
    company: formData.get("company") ?? undefined,
  });
  if (!parsed.success) {
    // Honeypot or malformed: respond neutrally to avoid probing, but don't email.
    return NEUTRAL;
  }
  const { last_name, email, birthdate } = parsed.data;

  const admin = createAdminClient();
  const { data: match } = await admin
    .from("patients")
    .select("id, drm_id, first_name")
    .eq("email", email)
    .eq("last_name", last_name)
    .eq("birthdate", birthdate)
    .is("merged_into_id", null)
    .limit(1)
    .maybeSingle();

  if (match) {
    const send = await sendEmail({
      to: email,
      subject: "Your DRMed DRM-ID",
      text: `Hi ${match.first_name},\n\nYour DRMed DRM-ID is ${match.drm_id}. Use it with your receipt PIN to view your results at drmed.ph/portal.\n\nIf you didn't request this, you can ignore this email.`,
      html: renderEmailShell({
        heading: "Your DRMed patient ID",
        contentHtml:
          emailParagraph(`Hi <b>${escapeHtml(match.first_name)}</b>,`) +
          emailParagraph("Here is the DRM-ID linked to your details:") +
          emailHighlight("Your DRM-ID", match.drm_id) +
          emailParagraph("Use it with your receipt PIN to view your results at drmed.ph/portal. If you didn't request this, you can ignore this email."),
        receivedNote: "You received this because someone requested a DRM-ID for this email at drmed.ph.",
      }),
    });
    await audit({
      actor_id: null, actor_type: "anonymous", patient_id: match.id,
      action: "patient.id_recovery.matched", resource_type: "patient", resource_id: match.id,
      metadata: { drm_id: match.drm_id, email: send.ok ? { ok: true, id: send.id, to: email } : send.kind === "skipped" ? { ok: false, skipped: true, reason: send.reason } : { ok: false, error: send.error, to: email } },
      ip_address: ip || null, user_agent: ua,
    });
  } else {
    await audit({
      actor_id: null, actor_type: "anonymous",
      action: "patient.id_recovery.no_match", resource_type: "patient",
      metadata: { attempted_email: email },
      ip_address: ip || null, user_agent: ua,
    });
  }

  return NEUTRAL;
}
