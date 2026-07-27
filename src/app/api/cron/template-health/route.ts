import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailButton } from "@/lib/notifications/branded-email";
import type { Json } from "@/types/database";

// Daily scan for report-group template drift — the class of failure that let
// the CHEMISTRY group template silently lose 13 of 14 params and sit broken
// for ~2 months (0115/0121/0122 all trace back to that incident). Read-only:
// this route never mutates state, it only detects and reports.
//
// Checks (report_groups + their result_templates / result_template_params /
// report_group_service_params):
//   1. Active group template with 0 params      — encoding form is broken.
//   2. Active template w/ params but zero report_group_service_params rows
//      across the whole group                   — every field disabled.
//   3. An individual active, non-lab_package grouped service with zero
//      mapping rows to its group's active template params
//                                                 — this service enables nothing.
//   4. Group template inactive while the group still has active services
//                                                 — consolidated queue form
//                                                    will not load for them.
//   5. A param of an active group template enabled by no service (informational)
//                                                 — unreachable field.
//
// Mirrors dedup-digest's shape exactly: CRON_SECRET auth, admin client,
// {ok, ...} JSON response, one audit_log row + admin email only when there
// is something to report (silent + no writes when everything is healthy).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Finding {
  type:
    | "template_zero_params"
    | "group_zero_mappings"
    | "service_zero_mappings"
    | "template_inactive_active_services"
    | "unreachable_param";
  severity: "error" | "warning" | "info";
  group_id: string;
  group_code: string;
  group_name: string;
  template_id: string | null;
  service_id?: string;
  service_code?: string;
  param_id?: string;
  param_name?: string;
  message: string;
}

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
          .select("id, template_id, parameter_name")
          .in("template_id", templateIds)
      : { data: [] as { id: string; template_id: string; parameter_name: string }[] };
    const paramsByTemplate = new Map<string, { id: string; parameter_name: string }[]>();
    for (const p of paramRows ?? []) {
      const arr = paramsByTemplate.get(p.template_id) ?? [];
      arr.push({ id: p.id, parameter_name: p.parameter_name });
      paramsByTemplate.set(p.template_id, arr);
    }
    const paramIds = (paramRows ?? []).map((p) => p.id);

    const { data: mapRows } = paramIds.length
      ? await admin
          .from("report_group_service_params")
          .select("service_id, parameter_id")
          .in("parameter_id", paramIds)
      : { data: [] as { service_id: string; parameter_id: string }[] };
    const mappedServiceIdsByParam = new Map<string, Set<string>>();
    const mappedParamCountByService = new Map<string, number>();
    for (const m of mapRows ?? []) {
      const set = mappedServiceIdsByParam.get(m.parameter_id) ?? new Set<string>();
      set.add(m.service_id);
      mappedServiceIdsByParam.set(m.parameter_id, set);
      mappedParamCountByService.set(
        m.service_id,
        (mappedParamCountByService.get(m.service_id) ?? 0) + 1,
      );
    }

    const findings: Finding[] = [];

    for (const g of groupList) {
      const tpl = templateByGroup.get(g.id) ?? null;
      const members = serviceList.filter((s) => s.report_group_id === g.id);
      const activeMembers = members.filter((s) => s.is_active);
      const params = tpl ? (paramsByTemplate.get(tpl.id) ?? []) : [];

      // 1. Active template, 0 params — encoding form broken.
      if (tpl && tpl.is_active && params.length === 0) {
        findings.push({
          type: "template_zero_params",
          severity: "error",
          group_id: g.id,
          group_code: g.code,
          group_name: g.name,
          template_id: tpl.id,
          message: `${g.name}: active group template has 0 parameters — the encoding form is broken.`,
        });
      }

      // 2. Active template with params but zero mappings across the whole group.
      const groupHasAnyMapping = members.some(
        (m) => (mappedParamCountByService.get(m.id) ?? 0) > 0,
      );
      if (tpl && tpl.is_active && params.length > 0 && !groupHasAnyMapping) {
        findings.push({
          type: "group_zero_mappings",
          severity: "error",
          group_id: g.id,
          group_code: g.code,
          group_name: g.name,
          template_id: tpl.id,
          message: `${g.name}: no service is mapped to this template's fields — every field on the consolidated encoding form is disabled.`,
        });
      }

      // 3. Individual active, non-lab_package service with zero mappings to
      // its group's active template. Only meaningful once the template
      // itself has params and is active — checks 1/2 already cover the
      // fully-broken cases and would otherwise be redundant with this one.
      if (tpl && tpl.is_active && params.length > 0) {
        for (const svc of members) {
          if (!svc.is_active || svc.kind === "lab_package") continue;
          const enabledCount = mappedParamCountByService.get(svc.id) ?? 0;
          if (enabledCount === 0) {
            findings.push({
              type: "service_zero_mappings",
              severity: "warning",
              group_id: g.id,
              group_code: g.code,
              group_name: g.name,
              template_id: tpl.id,
              service_id: svc.id,
              service_code: svc.code,
              message: `${svc.code} (${g.name}): this orderable service enables no fields on the consolidated form.`,
            });
          }
        }
      }

      // 4. Template inactive while the group still has active services.
      if (tpl && !tpl.is_active && activeMembers.length > 0) {
        findings.push({
          type: "template_inactive_active_services",
          severity: "error",
          group_id: g.id,
          group_code: g.code,
          group_name: g.name,
          template_id: tpl.id,
          message: `${g.name}: template is inactive but ${activeMembers.length} service(s) in the group are active — the consolidated queue form will not load.`,
        });
      }

      // 5. Informational: a param of an active template enabled by no service.
      if (tpl && tpl.is_active && params.length > 0) {
        for (const p of params) {
          const enabledBy = mappedServiceIdsByParam.get(p.id)?.size ?? 0;
          if (enabledBy === 0) {
            findings.push({
              type: "unreachable_param",
              severity: "info",
              group_id: g.id,
              group_code: g.code,
              group_name: g.name,
              template_id: tpl.id,
              param_id: p.id,
              param_name: p.parameter_name,
              message: `${g.name}: "${p.parameter_name}" is not enabled by any service — unreachable field.`,
            });
          }
        }
      }
    }

    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;

    if (findings.length === 0) {
      return NextResponse.json({ ok: true, findings: 0, counts });
    }

    // audit() requires resource_id? no — it's optional/nullable, but keep the
    // row anchored to the first finding's template for easy cross-reference.
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
