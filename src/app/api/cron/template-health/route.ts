import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailButton } from "@/lib/notifications/branded-email";
import {
  deriveTemplateHealthFindings,
  type TemplateHealthGroup,
} from "@/lib/results/template-health";
import type { Json } from "@/types/database";

// Daily scan for report-group template drift — the class of failure that let
// the CHEMISTRY group template silently lose 13 of 14 params and sit broken
// for ~2 months (0115/0121/0122 all trace back to that incident). Read-only:
// this route never mutates state, it only detects and reports. The five
// checks themselves live in the pure, unit-tested
// src/lib/results/template-health.ts (deriveTemplateHealthFindings) — this
// route is just data-fetch -> derive -> audit/notify.
//
// Auth follows data-retention/sync-accounting's stricter guard (explicit
// 500 when CRON_SECRET itself isn't configured, then 401 on a bad/missing
// bearer token) — dedup-digest skips the former and goes straight to the
// 401 check. The admin-notification mechanism mirrors dedup-digest exactly:
// active admins resolved via staff_profiles + auth.users emails, sendEmail
// with the shared branded shell, one audit_log row, only when there is
// something to report (silent + no writes when everything is healthy).

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

  const admin = createAdminClient();

  try {
    const { data: groups } = await admin
      .from("report_groups")
      .select("id, code, name, is_active");
    const groupList = groups ?? [];
    if (groupList.length === 0) {
      return NextResponse.json({ ok: true, findings: 0, counts: {} });
    }
    const groupIds = groupList.map((g) => g.id);

    const { data: services } = await admin
      .from("services")
      .select("id, code, name, kind, is_active, report_group_id")
      .in("report_group_id", groupIds);
    const serviceList = services ?? [];

    const { data: groupTemplates } = await admin
      .from("result_templates")
      .select("id, report_group_id, is_active")
      .in("report_group_id", groupIds);
    const templateList = groupTemplates ?? [];
    const templateByGroup = new Map(templateList.map((t) => [t.report_group_id!, t]));
    const templateIds = templateList.map((t) => t.id);

    const { data: paramRows } = templateIds.length
      ? await admin
          .from("result_template_params")
          .select("id, template_id, parameter_name, gender")
          .in("template_id", templateIds)
      : {
          data: [] as {
            id: string;
            template_id: string;
            parameter_name: string;
            gender: string | null;
          }[],
        };
    const paramsByTemplate = new Map<
      string,
      { id: string; parameter_name: string; gender: string | null }[]
    >();
    for (const p of paramRows ?? []) {
      const arr = paramsByTemplate.get(p.template_id) ?? [];
      arr.push({ id: p.id, parameter_name: p.parameter_name, gender: p.gender });
      paramsByTemplate.set(p.template_id, arr);
    }
    const paramIds = (paramRows ?? []).map((p) => p.id);

    const { data: mapRows } = paramIds.length
      ? await admin
          .from("report_group_service_params")
          .select("service_id, parameter_id")
          .in("parameter_id", paramIds)
      : { data: [] as { service_id: string; parameter_id: string }[] };

    const groupsInput: TemplateHealthGroup[] = groupList.map((g) => {
      const tpl = templateByGroup.get(g.id) ?? null;
      return {
        id: g.id,
        code: g.code,
        name: g.name,
        template: tpl ? { id: tpl.id, is_active: tpl.is_active } : null,
        params: tpl ? (paramsByTemplate.get(tpl.id) ?? []) : [],
        services: serviceList
          .filter((s) => s.report_group_id === g.id)
          .map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            is_active: s.is_active,
            kind: s.kind,
          })),
      };
    });

    const findings = deriveTemplateHealthFindings({
      groups: groupsInput,
      links: mapRows ?? [],
    });

    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;

    if (findings.length === 0) {
      return NextResponse.json({ ok: true, findings: 0, counts });
    }

    // resource_id is nullable on audit() — anchor the row to the first
    // finding's template for easy cross-reference.
    await audit({
      actor_id: null,
      actor_type: "system",
      action: "result_template.health_alert",
      resource_type: "result_template",
      resource_id: findings[0].template_id,
      metadata: { findings, counts } as unknown as Json,
    });

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
    const reviewUrl = `${base}/staff/admin/result-templates`;
    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warnCount = findings.filter((f) => f.severity === "warning").length;
    const infoCount = findings.filter((f) => f.severity === "info").length;
    const html = renderEmailShell({
      heading: "Result-template drift detected",
      contentHtml:
        emailParagraph(
          `The daily template-health check found <b>${findings.length}</b> issue(s) across report-group templates (${errorCount} broken, ${warnCount} warning, ${infoCount} informational).`,
        ) + emailButton("Review result templates", reviewUrl, "cyan"),
    });

    let emailed = 0;
    for (const to of recipients) {
      const r = await sendEmail({
        to,
        subject: `DRMed: ${findings.length} result-template health issue(s)`,
        text: `${findings.length} result-template health issue(s) found. Review at ${reviewUrl}`,
        html,
      });
      if (r.ok) emailed += 1;
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
}
