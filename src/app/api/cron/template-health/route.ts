import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailButton, escapeHtml } from "@/lib/notifications/branded-email";
import { isTemplateHealthStale, shouldEmailTemplateHealth } from "@/lib/results/template-health";
import { collectTemplateHealthFindings, getLastTemplateHealthDailyRun } from "@/lib/results/collect-template-health";
import { manilaDateTime } from "@/lib/dates/manila";
import type { Json } from "@/types/database";

// Daily alerts and a weekly summary for report-group template drift — the failure that let
// the CHEMISTRY group template silently lose 13 of 14 params and sit broken
// for ~2 months (0115/0121/0122 all trace back to that incident). Read-only:
// this route never mutates templates, it only detects and reports. The six
// checks themselves live in the pure, unit-tested
// src/lib/results/template-health.ts (deriveTemplateHealthFindings) — this
// route is just data-fetch -> derive -> audit/notify.
//
// Auth follows data-retention/sync-accounting's stricter guard (explicit
// 500 when CRON_SECRET itself isn't configured, then 401 on a bad/missing
// bearer token) — dedup-digest skips the former and goes straight to the
// 401 check. The admin-notification mechanism mirrors dedup-digest exactly:
// active admins resolved via staff_profiles + auth.users emails, sendEmail
// with the shared branded shell. Every completed scan writes an audit_log
// heartbeat, including clean scans; a gap in daily runs also triggers email.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const mode = new URL(request.url).searchParams.get("mode") === "weekly" ? "weekly" : "daily";

  return withCronMonitor(mode === "weekly" ? "template-health-weekly" : "template-health", async (markFailed) => {
    const admin = createAdminClient();

    try {
      // Read BEFORE audit(): a daily run must not read its own heartbeat and hide a gap.
      const lastDailyRun = await getLastTemplateHealthDailyRun(admin);
      const dailyRunStale = isTemplateHealthStale(lastDailyRun, new Date());
      const { findings, counts } = await collectTemplateHealthFindings(admin);

      // Anchor to the first finding when present; clean scans still record a heartbeat.
      await audit({
        actor_id: null,
        actor_type: "system",
        action: mode === "weekly" ? "result_template.health_summary" : "result_template.health_alert",
        resource_type: "result_template",
        resource_id: findings[0]?.template_id ?? null,
        metadata: { findings, counts } as unknown as Json,
      });

      if (findings.length === 0 && !dailyRunStale) {
        return NextResponse.json({ ok: true, findings: 0, counts });
      }

      // A recovered daily gap or ongoing weekly-detected outage overrides the findings gate.
      if (!shouldEmailTemplateHealth(findings, mode, dailyRunStale)) {
        return NextResponse.json({
          ok: true,
          findings: findings.length,
          counts,
          recipients: 0,
          emailed: 0,
        });
      }

      // Same notification mechanism as dedup-digest: active admins, resolved
      // via staff_profiles + auth.users emails, sendEmail with the shared
      // branded shell. No new notification channel.
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
      const reviewUrl = `${base}/staff/admin/result-templates/health`;
      const errorCount = findings.filter((f) => f.severity === "error").length;
      const warnCount = findings.filter((f) => f.severity === "warning").length;
      const infoCount = findings.filter((f) => f.severity === "info").length;
      const gapMessage = !dailyRunStale ? "" : mode === "daily"
        ? lastDailyRun
          ? `The daily template-health check has resumed. It had not run since ${manilaDateTime(lastDailyRun)} (Manila time), leaving a gap in monitoring.`
          : "The daily template-health check has run, but there is no prior record of it running. Monitoring before this run cannot be confirmed."
        : lastDailyRun
          ? `The daily template-health check appears to have stopped running. Its last recorded run was ${manilaDateTime(lastDailyRun)} (Manila time). Please investigate the daily cron.`
          : "The daily template-health check appears to have stopped running: there is no prior record of it running. Please investigate the daily cron.";
      const html = renderEmailShell({
        heading: mode === "weekly" ? "Weekly result-template summary" : "Result-template drift detected",
        contentHtml:
          (gapMessage ? emailParagraph(`<b>${escapeHtml(gapMessage)}</b>`) : "") +
          emailParagraph(
            `The ${mode} template-health check found <b>${findings.length}</b> issue(s) across report-group templates (${errorCount} broken, ${warnCount} warning, ${infoCount} informational).`,
          ) + emailButton("Review result templates", reviewUrl, "cyan"),
      });

      let emailed = 0;
      for (const to of recipients) {
        const r = await sendEmail({
          to,
          subject: mode === "weekly"
            ? `DRMed: weekly result-template summary (${findings.length} issue(s))`
            : `DRMed: ${findings.length} result-template health issue(s)`,
          text: `${gapMessage ? `${gapMessage}\n\n` : ""}${findings.length} result-template health issue(s) found. Review at ${reviewUrl}`,
          html,
        });
        if (r.ok) emailed += 1;
        else markFailed();
      }

      return NextResponse.json({
        ok: true,
        findings: findings.length,
        counts,
        recipients: recipients.length,
        emailed,
      });
    } catch (error) {
      await reportError({ scope: "cron/template-health", error });
      return NextResponse.json({ ok: false, error: "failed" }, { status: 500 });
    }
  });
}
