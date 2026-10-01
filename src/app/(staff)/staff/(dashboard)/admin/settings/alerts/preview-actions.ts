"use server";

// Admin Tools › Email Alerts — "Send me a preview" for the two Patient Sources emails.
// Modelled on sendTestAlertAction (actions.ts): requireAdminStaff() is the EFFECTIVE-role
// gate every action on this page uses; the input is validated; the service-role client is
// used only to read the numbers. It emails ONLY the signed-in admin, never the alert's
// recipients, and never touches the send-claim table or the `.sent` audit row — a preview
// can neither count as the real send nor block it.

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { todayManilaISODate } from "@/lib/dates/manila";
import { sendEmail } from "@/lib/notifications/email";
import { DIGEST_ALERT_KEY, type DigestKind } from "@/lib/marketing/patient-sources-digest";
import { buildPatientSourcesDigestEmail } from "@/lib/marketing/patient-sources-digest.server";

type ActionDataResult<T> = { ok: true; data: T } | { ok: false; error: string };

const KindSchema = z.enum(["week", "month"]);

export async function sendPatientSourcesPreviewAction(
  kind: DigestKind,
): Promise<ActionDataResult<{ sentTo: string; periodFrom: string }>> {
  const session = await requireAdminStaff();
  const parsed = KindSchema.safeParse(kind);
  if (!parsed.success) return { ok: false, error: "Could not read which email to preview." };
  if (!session.email) {
    return { ok: false, error: "Your account has no email address on file, so there is nowhere to send a preview." };
  }

  const built = await buildPatientSourcesDigestEmail(
    createAdminClient(),
    parsed.data,
    todayManilaISODate(),
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph",
  );
  if (!built.ok) return { ok: false, error: "Couldn't build the preview from the numbers right now — try again in a minute." };
  if (built.kind === "too_early") {
    return { ok: false, error: "There is nothing to preview yet: that period starts before Patient Sources' first date." };
  }

  const result = await sendEmail({ to: session.email, subject: `[Preview] ${built.subject}`, text: built.text, html: built.html });
  if (!result.ok) {
    // A skipped send carries emailStatus()'s own wording ("NOTIFICATIONS_LIVE not enabled…", "…not configured").
    return { ok: false, error: result.kind === "skipped" ? result.reason : "The email service did not accept the preview — try again." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.preview_sent",
    resource_type: "staff_alert_settings",
    resource_id: null,
    metadata: { alert_key: DIGEST_ALERT_KEY[parsed.data], period_from: built.period.from },
    ip_address: ip,
    user_agent: ua,
  });
  return { ok: true, data: { sentTo: session.email, periodFrom: built.period.from } };
}
