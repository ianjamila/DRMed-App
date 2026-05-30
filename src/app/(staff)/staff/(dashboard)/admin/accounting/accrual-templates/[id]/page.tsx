import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { AccrualTemplateForm } from "../template-form";
import { DeactivateButton } from "./deactivate-button";

export const metadata = { title: "Edit accrual template — staff" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
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
  frequency: string;
  is_active: boolean;
  accrual_template_lines: TemplateLine[] | null;
}

export default async function EditAccrualTemplatePage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: template }, { data: accounts }] = await Promise.all([
    admin
      .from("accrual_templates")
      .select(
        "id, name, description, frequency, is_active, accrual_template_lines ( account_id, debit_php, credit_php, description, line_order )",
      )
      .eq("id", id)
      .maybeSingle<TemplateRow>(),
    admin
      .from("chart_of_accounts")
      .select("id, code, name, type")
      .eq("is_active", true)
      .order("code"),
  ]);

  if (!template) notFound();

  const orderedLines = [...(template.accrual_template_lines ?? [])].sort(
    (a, b) => a.line_order - b.line_order,
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/accounting/accrual-templates"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Accrual templates
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Edit accrual template
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Changes don&apos;t affect already-posted journal entries; they
            apply to future <strong>Apply</strong> clicks only.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/staff/admin/accounting/journal/new?from_template=${template.id}`}
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Apply →
          </Link>
          {template.is_active ? <DeactivateButton id={template.id} /> : null}
        </div>
      </div>

      <div className="mt-6">
        <AccrualTemplateForm
          accounts={accounts ?? []}
          initial={{
            id: template.id,
            name: template.name,
            description: template.description,
            frequency: template.frequency,
            is_active: template.is_active,
            lines: orderedLines.map((l) => ({
              account_id: l.account_id,
              debit_php: Number(l.debit_php),
              credit_php: Number(l.credit_php),
              description: l.description,
            })),
          }}
        />
      </div>
    </div>
  );
}
