"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { sendEmail } from "@/lib/notifications/email";
import { renderMarkdown } from "@/lib/newsletter/markdown";
import {
  plainTextFromMarkdown,
  wrapEmailHtml,
} from "@/lib/newsletter/email-template";
import { ComposeCampaignSchema } from "@/lib/validations/newsletter";
import { SITE } from "@/lib/marketing/site";

export type CampaignResult =
  | { ok: true; recipientCount: number }
  | { ok: false; error: string };

const BATCH_SIZE = 5; // ≤ Resend free-tier 10 req/sec ceiling

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function sendCampaignAction(
  _prev: CampaignResult | null,
  formData: FormData,
): Promise<CampaignResult> {
  const session = await requireAdminStaff();

  const parsed = ComposeCampaignSchema.safeParse({
    subject: formData.get("subject"),
    body_md: formData.get("body_md"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  // Find active subscribers up front so we can refuse the send if there
  // are none (and keep an empty campaign row out of the table).
  const { data: subscribers, error: subErr } = await admin
    .from("subscribers")
    .select("id, email, unsubscribe_token")
    .is("unsubscribed_at", null);
  if (subErr) {
    return { ok: false, error: subErr.message };
  }
  const activeSubscribers = subscribers ?? [];
  if (activeSubscribers.length === 0) {
    return {
      ok: false,
      error: "There are no active subscribers — nothing to send.",
    };
  }

  const renderedBodyHtml = renderMarkdown(parsed.data.body_md);

  // Insert campaign row with the rendered HTML so the row itself is the
  // audit artifact for this send.
  const { data: campaign, error: insErr } = await admin
    .from("newsletter_campaigns")
    .insert({
      subject: parsed.data.subject,
      body_md: parsed.data.body_md,
      body_html: renderedBodyHtml,
      sent_at: new Date().toISOString(),
      sent_by: session.user_id,
      recipient_count: 0,
    })
    .select("id")
    .single();
  if (insErr || !campaign) {
    return {
      ok: false,
      error: insErr?.message ?? "Could not create the campaign.",
    };
  }

  const plainText = plainTextFromMarkdown(parsed.data.body_md);
  let delivered = 0;
  let failed = 0;

  for (let i = 0; i < activeSubscribers.length; i += BATCH_SIZE) {
    const batch = activeSubscribers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (sub) => {
        const unsubscribeUrl = `${SITE.url}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
        const html = wrapEmailHtml({
          subject: parsed.data.subject,
          bodyHtml: renderedBodyHtml,
          unsubscribeUrl,
        });
        const text = `${plainText}\n\n---\nUnsubscribe: ${unsubscribeUrl}`;
        return sendEmail({
          to: sub.email,
          subject: parsed.data.subject,
          html,
          text,
        });
      }),
    );
    for (const r of results) {
      if (r.ok) delivered += 1;
      else failed += 1;
    }
  }

  await admin
    .from("newsletter_campaigns")
    .update({ recipient_count: delivered })
    .eq("id", campaign.id);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "newsletter.campaign.sent",
    resource_type: "newsletter_campaign",
    resource_id: campaign.id,
    metadata: {
      subject: parsed.data.subject,
      attempted: activeSubscribers.length,
      delivered,
      failed,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/newsletter");
  redirect(
    `/staff/admin/newsletter?sent=${campaign.id}&delivered=${delivered}&failed=${failed}`,
  );
}
