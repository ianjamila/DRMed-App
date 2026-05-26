import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Accrual templates — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  frequency: string;
  is_active: boolean;
  updated_at: string;
  accrual_template_lines: { debit_php: number; credit_php: number }[] | null;
}

const FREQ_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  on_demand: "On-demand",
};

interface SearchProps {
  searchParams: Promise<{ scope?: "active" | "all" }>;
}

export default async function AccrualTemplatesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;
  const scope = sp.scope === "all" ? "all" : "active";

  const admin = createAdminClient();

  let query = admin
    .from("accrual_templates")
    .select(
      "id, name, description, frequency, is_active, updated_at, accrual_template_lines ( debit_php, credit_php )",
    )
    .order("name", { ascending: true });
  if (scope === "active") query = query.eq("is_active", true);

  const { data } = await query.returns<TemplateRow[]>();
  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Accrual templates
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Named recurring JE shapes. Hit <strong>Apply</strong> on a template
            to pre-fill the manual JE form — admin still reviews + posts.
            No automatic cron yet.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/accrual-templates/new"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          + New template
        </Link>
      </header>

      <nav className="my-4 flex flex-wrap gap-2">
        <Link
          href="/staff/admin/accounting/accrual-templates"
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "active"
              ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          Active
        </Link>
        <Link
          href="/staff/admin/accounting/accrual-templates?scope=all"
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "all"
              ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          All (incl. retired)
        </Link>
      </nav>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No templates yet. Click <strong>+ New template</strong> to create
            your first recurring-accrual shape.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Frequency</th>
                <th className="px-4 py-3 text-right">Lines</th>
                <th className="px-4 py-3 text-right">Suggested ₱</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {rows.map((t) => {
                const lines = t.accrual_template_lines ?? [];
                const totalDebit = lines.reduce(
                  (s, l) => s + Number(l.debit_php ?? 0),
                  0,
                );
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/staff/admin/accounting/accrual-templates/${t.id}`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {t.name}
                        </Link>
                        {!t.is_active ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                            Retired
                          </span>
                        ) : null}
                      </div>
                      {t.description ? (
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {t.description}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {FREQ_LABEL[t.frequency] ?? t.frequency}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {lines.length}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                      {totalDebit > 0 ? PHP.format(totalDebit) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/staff/admin/accounting/journal/new?from_template=${t.id}`}
                        className="rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-cyan)] hover:text-white"
                      >
                        Apply →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
