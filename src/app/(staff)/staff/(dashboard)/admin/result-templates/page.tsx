// Phase 13 Slice 1: discovery page for result templates.
// Lists every service that could have a template (in-house, non-send-out)
// and shows whether one exists. Each row with a template links to the PDF
// preview route. Full template editing UI lands in Slice 3.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export const metadata = { title: "Result templates — staff" };

interface ServiceRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  is_send_out: boolean;
  templateLayout: string | null;
  reportGroupId: string | null;
}

export default async function ResultTemplatesIndex() {
  const session = await requireActiveStaff();
  if (session.role !== "admin") redirect("/staff");

  const supabase = await createClient();

  const { data: services } = await supabase
    .from("services")
    .select("id, code, name, kind, is_send_out, is_active, report_group_id")
    .eq("is_active", true)
    .order("name", { ascending: true });

  const { data: templates } = await supabase
    .from("result_templates")
    .select("service_id, layout, is_active");

  const { data: groups } = await supabase
    .from("report_groups")
    .select("id, code, name, is_active");

  const { data: groupTemplates } = await supabase
    .from("result_templates")
    .select("id, report_group_id, layout, is_active")
    .not("report_group_id", "is", null);

  const { data: paramRows } = (groupTemplates ?? []).length
    ? await supabase
        .from("result_template_params")
        .select("template_id")
        .in(
          "template_id",
          (groupTemplates ?? []).map((t) => t.id),
        )
    : { data: [] };
  const paramCountByTemplate = new Map<string, number>();
  for (const r of paramRows ?? []) {
    paramCountByTemplate.set(
      r.template_id,
      (paramCountByTemplate.get(r.template_id) ?? 0) + 1,
    );
  }

  const tplByService = new Map<string, string>();
  for (const t of templates ?? []) {
    if (t.is_active && t.service_id) tplByService.set(t.service_id, t.layout);
  }

  const rows: ServiceRow[] = (services ?? [])
    // Imaging services live under kind='lab_test' (with section='imaging_*'),
    // so this filter covers X-Ray and Ultrasound as well.
    .filter((s) => ["lab_test", "lab_package"].includes(s.kind ?? ""))
    .map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      kind: s.kind,
      is_send_out: s.is_send_out ?? false,
      templateLayout: tplByService.get(s.id) ?? null,
      reportGroupId: s.report_group_id ?? null,
    }));

  const grouped = rows.filter((r) => r.reportGroupId);
  const ungrouped = rows.filter((r) => !r.reportGroupId);
  const withTemplate = ungrouped.filter((r) => r.templateLayout);
  const eligibleNoTemplate = ungrouped.filter(
    (r) => !r.templateLayout && !r.is_send_out,
  );
  const sendOut = ungrouped.filter((r) => r.is_send_out);

  // Which grouped services actually have a report_group_service_params row —
  // a group can have an active, populated template that nothing maps to
  // (e.g. every member service was re-pointed at a different group), which
  // silently disables every field on the consolidated encoding form.
  const { data: groupMapRows } = grouped.length
    ? await supabase
        .from("report_group_service_params")
        .select("service_id")
        .in(
          "service_id",
          grouped.map((r) => r.id),
        )
    : { data: [] };
  const mappedServiceIds = new Set(
    (groupMapRows ?? []).map((r) => r.service_id),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 13 · Admin
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Result templates
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Templates power the medtech structured-result form and the
          auto-generated result PDF. Open a preview to see how a finalised PDF
          will look — values are synthesised placeholders for layout review.
        </p>
      </header>

      <Section
        title="Report groups (consolidated templates)"
        subtitle="One shared template per group — services below route to a single consolidated report form in the queue."
      >
        {(groups ?? []).length === 0 ? (
          <Empty text="No report groups configured." />
        ) : (
          <ul className="grid gap-3">
            {(groups ?? []).map((g) => {
              const tpl = (groupTemplates ?? []).find(
                (t) => t.report_group_id === g.id,
              );
              const nParams = tpl ? (paramCountByTemplate.get(tpl.id) ?? 0) : 0;
              const members = grouped.filter((r) => r.reportGroupId === g.id);
              const broken = !!tpl && tpl.is_active && nParams === 0;
              const hasAnyMapping = members.some((m) =>
                mappedServiceIds.has(m.id),
              );
              const noMappings =
                !!tpl && tpl.is_active && nParams > 0 && !hasAnyMapping;
              return (
                <li
                  key={g.id}
                  className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.code}
                      </p>
                      <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                        {g.name}
                        {!g.is_active ? (
                          <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700">
                            Inactive
                          </span>
                        ) : null}
                        <span className="ml-2 text-xs font-normal text-[color:var(--color-brand-text-soft)]">
                          {tpl
                            ? `${tpl.layout} · ${nParams} param${nParams === 1 ? "" : "s"} · ${members.length} services`
                            : "no template yet"}
                        </span>
                      </p>
                      {broken ? (
                        <p className="mt-0.5 text-xs font-bold text-red-700">
                          ⚠ Active template with 0 parameters — the encoding
                          form is broken.
                        </p>
                      ) : null}
                      {noMappings ? (
                        <p className="mt-0.5 text-xs font-bold text-red-700">
                          ⚠ No services are mapped to this template&apos;s
                          fields — every field on the consolidated encoding
                          form is disabled.
                        </p>
                      ) : null}
                      {tpl && !tpl.is_active ? (
                        <p className="mt-0.5 text-xs font-bold text-amber-700">
                          Template inactive — the consolidated queue form will
                          not load.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Link
                        href={`/staff/admin/result-templates/group/${g.id}/edit`}
                        className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                      >
                        {tpl ? "Edit" : "Create"}
                      </Link>
                      {tpl ? (
                        <Link
                          href={`/staff/admin/result-templates/preview/group/${g.id}`}
                          target="_blank"
                          rel="noopener"
                          className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
                        >
                          Preview PDF
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  {members.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        Managed by this group:
                      </span>
                      {members.map((m) => (
                        <span
                          key={m.id}
                          className="font-mono text-[10px] text-[color:var(--color-brand-text-mid)]"
                        >
                          {m.code}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="With template"
        subtitle={`${withTemplate.length} service${withTemplate.length === 1 ? "" : "s"} have a template configured`}
      >
        {withTemplate.length === 0 ? (
          <Empty text="No templates configured yet. Run `npm run seed:templates` to install the three reference archetypes." />
        ) : (
          <ul className="divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            {withTemplate.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.code}
                  </p>
                  <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                    {r.name}
                  </p>
                </div>
                <span className="rounded-md bg-[color:var(--color-brand-bg-mid)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-mid)]">
                  {r.templateLayout}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/staff/admin/result-templates/${r.id}/edit`}
                    className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                  >
                    Edit
                  </Link>
                  <Link
                    href={`/staff/admin/result-templates/preview/${r.id}`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
                  >
                    Preview PDF
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Eligible without template"
        subtitle={`${eligibleNoTemplate.length} in-house service${eligibleNoTemplate.length === 1 ? "" : "s"} fall back to PDF upload until a template is added`}
      >
        {eligibleNoTemplate.length === 0 ? (
          <Empty text="Every in-house service has a template." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {eligibleNoTemplate.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                    {r.code}
                  </p>
                  <p className="truncate text-sm text-[color:var(--color-brand-text-mid)]">
                    {r.name}
                  </p>
                </div>
                <Link
                  href={`/staff/admin/result-templates/${r.id}/edit`}
                  className="shrink-0 rounded-md bg-[color:var(--color-brand-cyan)] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-navy)]"
                >
                  + Create
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {sendOut.length > 0 ? (
        <Section
          title="Send-out (templates not applicable)"
          subtitle="Send-out tests use the partner-lab PDF and are exempt from structured entry."
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {sendOut.map((r) => (
              <li
                key={r.id}
                className="rounded-lg bg-[color:var(--color-brand-bg)] px-3 py-2"
              >
                <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                  {r.code}
                </p>
                <p className="text-sm text-[color:var(--color-brand-text-mid)]">
                  {r.name}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
        {subtitle}
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
      {text}
    </p>
  );
}
