import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { ManualJeForm } from "./manual-je-form";

export const metadata = { title: "New journal entry — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ from_template?: string }>;
}

interface TemplateLine {
  account_id: string;
  debit_php: number;
  credit_php: number;
  description: string | null;
  line_order: number;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  accrual_template_lines: TemplateLine[] | null;
}

export default async function NewJournalEntryPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;
  const admin = createAdminClient();

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type, normal_balance")
    .eq("is_active", true)
    .order("code");

  let template: TemplateRow | null = null;
  if (sp.from_template) {
    const { data } = await admin
      .from("accrual_templates")
      .select(
        "id, name, description, accrual_template_lines ( account_id, debit_php, credit_php, description, line_order )",
      )
      .eq("id", sp.from_template)
      .eq("is_active", true)
      .maybeSingle<TemplateRow>();
    template = data ?? null;
  }

  const today = todayManilaISODate();

  const initialLines = template?.accrual_template_lines
    ? [...template.accrual_template_lines]
        .sort((a, b) => a.line_order - b.line_order)
        .map((l) => ({
          account_id: l.account_id,
          debit_php: Number(l.debit_php),
          credit_php: Number(l.credit_php),
          description: l.description ?? "",
        }))
    : undefined;

  const initialDescription = template
    ? `${template.name}${template.description ? ` — ${template.description}` : ""}`
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={
          template
            ? "/staff/admin/accounting/accrual-templates"
            : "/staff/admin/accounting/periods"
        }
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {template ? "Accrual templates" : "Accounting periods"}
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New journal entry
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {template ? (
          <>
            Applying template{" "}
            <strong className="text-[color:var(--color-brand-navy)]">
              {template.name}
            </strong>
            . Review the description, amounts, and posting date before
            posting — nothing has been written yet.
          </>
        ) : (
          <>
            Manual posting. Entry number is allocated automatically. The
            system blocks postings into closed periods and requires debits =
            credits before flipping a draft to posted.
          </>
        )}
      </p>

      <div className="mt-8">
        <ManualJeForm
          accounts={(accounts ?? []).map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            type: a.type,
          }))}
          defaultDate={today}
          today={today}
          initialDescription={initialDescription}
          initialLines={initialLines}
        />
      </div>
    </div>
  );
}
