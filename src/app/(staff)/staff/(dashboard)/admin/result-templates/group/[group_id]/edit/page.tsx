import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { loadTemplateParams } from "@/lib/results/loaders";
import { TemplateEditor } from "../../../[service_id]/edit/template-editor";
import { SupersededTemplates } from "./superseded-templates";
import { EncodingPreview } from "./encoding-preview";
import type {
  TemplateEditorPayload,
  TemplateParamPayload,
} from "@/lib/validations/result-template";

export const metadata = { title: "Edit group template — staff" };

interface Props {
  params: Promise<{ group_id: string }>;
}

export default async function EditGroupTemplatePage({ params }: Props) {
  const session = await requireAdminStaff();
  if (session.role !== "admin") redirect("/staff");

  const { group_id } = await params;
  const admin = createAdminClient();

  const { data: group } = await admin
    .from("report_groups")
    .select("id, code, name, is_active")
    .eq("id", group_id)
    .maybeSingle();
  if (!group) notFound();

  const { data: services } = await admin
    .from("services")
    .select("id, code, name, kind, is_active, is_send_out")
    .eq("report_group_id", group_id)
    .order("code", { ascending: true });
  const svcList = services ?? [];
  const svcIds = svcList.map((s) => s.id);

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes, is_active")
    .eq("report_group_id", group_id)
    .maybeSingle();

  // Mapping rows for this template's params (group targets only).
  const rawParams = tpl ? await loadTemplateParams(admin, tpl.id) : [];
  const paramIds = rawParams.map((p) => p.id);
  const { data: mapRows } = paramIds.length
    ? await admin
        .from("report_group_service_params")
        .select("service_id, parameter_id")
        .in("parameter_id", paramIds)
    : { data: [] as { service_id: string; parameter_id: string }[] };
  const svcsByParam = new Map<string, string[]>();
  for (const m of mapRows ?? []) {
    const arr = svcsByParam.get(m.parameter_id) ?? [];
    arr.push(m.service_id);
    svcsByParam.set(m.parameter_id, arr);
  }

  const initialParams: TemplateParamPayload[] = rawParams.map((p) => ({
    id: p.id,
    parameter_name: p.parameter_name,
    input_type: p.input_type,
    section: p.section,
    is_section_header: p.is_section_header,
    unit_si: p.unit_si,
    unit_conv: p.unit_conv,
    ref_low_si: p.ref_low_si,
    ref_high_si: p.ref_high_si,
    ref_low_conv: p.ref_low_conv,
    ref_high_conv: p.ref_high_conv,
    gender: p.gender,
    si_to_conv_factor: p.si_to_conv_factor,
    allowed_values: p.allowed_values,
    abnormal_values: p.abnormal_values,
    placeholder: p.placeholder,
    service_ids: svcsByParam.get(p.id) ?? null,
    ranges: p.ranges.map((r) => ({
      id: r.id,
      band_label: r.band_label,
      age_min_months: r.age_min_months,
      age_max_months: r.age_max_months,
      gender: r.gender,
      ref_low_si: r.ref_low_si,
      ref_high_si: r.ref_high_si,
      ref_low_conv: r.ref_low_conv,
      ref_high_conv: r.ref_high_conv,
    })),
  }));

  // Superseded per-service templates on this group's services.
  const { data: perSvcTpls } = svcIds.length
    ? await admin
        .from("result_templates")
        .select("id, service_id, is_active, result_template_params(id)")
        .in("service_id", svcIds)
    : { data: [] };
  const superseded = (perSvcTpls ?? [])
    .filter((t) => !t.is_active)
    .map((t) => {
      const svc = svcList.find((s) => s.id === t.service_id);
      return {
        templateId: t.id,
        serviceCode: svc?.code ?? "?",
        serviceName: svc?.name ?? "Unknown service",
        paramCount: (t.result_template_params ?? []).length,
      };
    });

  // Change history: the app's own saves + the 0121 delete-audit rows, merged
  // with superseded per-service template deletions scoped to this group.
  // The latter's resource_id is the *deleted per-service template's* id, not
  // this group template's, so they need a separate query keyed off metadata.
  const { data: ownHistory } = tpl
    ? await admin
        .from("audit_log")
        .select("id, actor_id, actor_type, action, metadata, created_at")
        .eq("resource_type", "result_template")
        .eq("resource_id", tpl.id)
        .order("created_at", { ascending: false })
        .limit(15)
    : { data: [] };
  const { data: supersededHistory } = await admin
    .from("audit_log")
    .select("id, actor_id, actor_type, action, metadata, created_at")
    .eq("resource_type", "result_template")
    .eq("action", "result_template.superseded_deleted")
    .eq("metadata->>report_group_id", group_id)
    .order("created_at", { ascending: false })
    .limit(15);
  const history = [...(ownHistory ?? []), ...(supersededHistory ?? [])]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 15);
  const actorIds = [
    ...new Set(history.map((h) => h.actor_id).filter((a): a is string => !!a)),
  ];
  const { data: actors } = actorIds.length
    ? await admin.from("staff_profiles").select("id, full_name").in("id", actorIds)
    : { data: [] };
  const actorName = new Map((actors ?? []).map((a) => [a.id, a.full_name]));

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/staff/admin/result-templates"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Result templates
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {tpl ? "Edit group template" : "Create group template"}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          One consolidated template shared by every service in the{" "}
          <strong>{group.name}</strong>
          {!group.is_active ? (
            <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
              Inactive
            </span>
          ) : null}{" "}
          group. The medtech queue routes all of them to a single{" "}
          {group.name} report form.
        </p>
      </div>

      {tpl && tpl.is_active && initialParams.length === 0 ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          This template is active but has no parameters — the {group.name}{" "}
          encoding form is broken until parameters are restored.
        </p>
      ) : null}

      {/* Mapped services */}
      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Services in this group ({svcList.length})
        </h3>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Changes to this template affect the encoding form and PDF for every
          service below.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {svcList.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                  {s.code}
                </p>
                <p className="truncate text-sm text-[color:var(--color-brand-text-mid)]">
                  {s.name}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {s.kind === "lab_package" ? (
                  <span className="rounded bg-[color:var(--color-brand-bg-mid)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-mid)]">
                    Billing header
                  </span>
                ) : null}
                {!s.is_active ? (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
                    Inactive
                  </span>
                ) : null}
                {s.is_send_out ? (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
                    Send-out⚠
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-[color:var(--color-brand-text-soft)]">
          Billing headers (lab packages) fan out into component tests at order
          time — they enable no fields themselves, their components do.
        </p>
      </section>

      <TemplateEditor
        target={{ kind: "group", id: group.id, code: group.code, name: group.name }}
        mappableServices={svcList
          .filter((s) => s.kind !== "lab_package")
          .map((s) => ({ id: s.id, code: s.code }))}
        hasTemplate={!!tpl}
        initialLayout={(tpl?.layout ?? "dual_unit") as TemplateEditorPayload["layout"]}
        initialHeaderNotes={tpl?.header_notes ?? null}
        initialFooterNotes={tpl?.footer_notes ?? null}
        initialIsActive={tpl?.is_active ?? true}
        initialParams={initialParams}
      />

      <EncodingPreview
        groupName={group.name}
        services={svcList.map((s) => ({
          id: s.id,
          code: s.code,
          kind: s.kind,
        }))}
        params={rawParams.map((p) => ({
          id: p.id,
          parameter_name: p.parameter_name,
          gender: p.gender,
          unit_si: p.unit_si,
          unit_conv: p.unit_conv,
          sort_order: p.sort_order,
        }))}
        links={(mapRows ?? []).map((m) => ({
          service_id: m.service_id,
          parameter_id: m.parameter_id,
        }))}
      />

      <SupersededTemplates
        groupId={group.id}
        groupName={group.name}
        items={superseded}
      />

      {/* Change history */}
      {tpl ? (
        <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
          <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Change history
          </h3>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            Saves from this screen plus database-level parameter deletions
            (logged by trigger since migration 0121). The 2-month CHEMISTRY
            outage was invisible precisely because nothing recorded the loss.
          </p>
          {history.length === 0 ? (
            <p className="mt-3 text-sm text-[color:var(--color-brand-text-soft)]">
              No recorded changes yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)]">
              {history.map((h) => {
                const meta = (h.metadata ?? {}) as Record<string, unknown>;
                const isDelete = h.action === "result_template.params_deleted";
                const isSupersededDelete =
                  h.action === "result_template.superseded_deleted";
                return (
                  <li key={h.id} className="flex items-baseline justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${isDelete || isSupersededDelete ? "text-red-700" : "text-[color:var(--color-brand-navy)]"}`}>
                        {isSupersededDelete
                          ? `Deleted superseded ${String(meta.service_code ?? "?")} template — ${String(meta.param_count ?? "?")} parameter(s)`
                          : isDelete
                            ? `Deleted ${String(meta.deleted_count ?? "?")} parameter(s) — ${String(meta.remaining_count ?? "?")} remaining`
                            : `Saved — ${String(meta.param_count ?? "?")} parameter(s)`}
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {h.actor_id
                          ? (actorName.get(h.actor_id) ?? "Unknown staff")
                          : `Database (${String(meta.db_role ?? "unknown role")})`}
                      </p>
                    </div>
                    <time className="shrink-0 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {new Date(h.created_at).toLocaleString("en-PH", {
                        timeZone: "Asia/Manila",
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
