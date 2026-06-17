import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailButton } from "@/lib/notifications/branded-email";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET by default. Weekly digest (Monday 01:00 UTC = 09:00
// Manila) emailing active admins the open possible-duplicate count + a link.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  try {
    const pairs = await loadCandidatePairs(admin, { minTier: "probable" });
    const byTier: Record<string, number> = { exact_dup: 0, strong: 0, probable: 0 };
    for (const p of pairs) {
      if (p.score.tier) byTier[p.score.tier] = (byTier[p.score.tier] ?? 0) + 1;
    }

    if (pairs.length === 0) {
      return Response.json({ candidates: 0, emailed: 0 });
    }

    // Active admins. staff_profiles has no email column — addresses live in
    // auth.users, resolved by id (same pattern as the staff users page).
    const { data: adminProfiles } = await admin
      .from("staff_profiles")
      .select("id")
      .eq("role", "admin")
      .eq("is_active", true);
    const { data: usersResp } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const emailById = new Map<string, string>();
    for (const u of usersResp?.users ?? []) {
      if (u.id && u.email) emailById.set(u.id, u.email);
    }
    const recipients = (adminProfiles ?? [])
      .map((p) => emailById.get(p.id))
      .filter((e): e is string => !!e);

    const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph";
    const reviewUrl = `${base}/staff/admin/patient-merge/candidates`;
    const html = renderEmailShell({
      heading: "Possible duplicate patients",
      contentHtml:
        emailParagraph(
          `There are <b>${pairs.length}</b> possible duplicate patient pairs to review (${byTier.exact_dup ?? 0} exact, ${byTier.strong ?? 0} strong, ${byTier.probable ?? 0} probable).`,
        ) + emailButton("Review duplicates", reviewUrl, "cyan"),
    });

    let emailed = 0;
    for (const to of recipients) {
      const r = await sendEmail({
        to,
        subject: `DRMed: ${pairs.length} possible duplicate patients`,
        text: `${pairs.length} possible duplicate pairs to review at ${reviewUrl}`,
        html,
      });
      if (r.ok) emailed += 1;
    }
    await audit({
      actor_id: null,
      actor_type: "system",
      action: "system.dedup_digest.sent",
      metadata: { candidates: pairs.length, by_tier: byTier, recipients: recipients.length, emailed },
    });
    return Response.json({ candidates: pairs.length, recipients: recipients.length, emailed });
  } catch (error) {
    await reportError({ scope: "cron/dedup-digest", error });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
