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
}

export default async function ResultTemplatesIndex() {
  const session = await requireActiveStaff();
  if (session.role !== "admin") redirect("/staff");

  const supabase = await createClient();

  const { data: services } = await supabase
    .from("services")
    .select("id, code, name, kind, is_send_out, is_active")
    .eq("is_active", true)
    .order("name", { ascending: true });

  const { data: templates } = await supabase
    .from("result_templates")
    .select("service_id, layout, is_active");

  const tplByService = new Map<string, string>();
  for (const t of templates ?? []) {
    if (t.is_active) tplByService.set(t.service_id, t.layout);
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
    }));

  const withTemplate = rows.filter((r) => r.templateLayout);
  const eligibleNoTemplate = rows.filter(
    (r) => !r.templateLayout && !r.is_send_out,
  );
  const sendOut = rows.filter((r) => r.is_send_out);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 13 · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Result templates
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Templates power the medtech structured-result form and the
          auto-generated result PDF. Open a preview to see how a finalised PDF
          will look — values are synthesised placeholders for layout review.
        </p>
      </header>

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
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
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
