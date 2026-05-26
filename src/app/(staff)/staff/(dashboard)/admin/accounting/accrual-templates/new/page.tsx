import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { AccrualTemplateForm } from "../template-form";

export const metadata = { title: "New accrual template — staff" };
export const dynamic = "force-dynamic";

export default async function NewAccrualTemplatePage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/accounting/accrual-templates"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Accrual templates
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New accrual template
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Save a recurring JE shape. Lines can be unbalanced or have zero
        amounts — admin fills in real numbers when applying.
      </p>

      <div className="mt-6">
        <AccrualTemplateForm accounts={accounts ?? []} />
      </div>
    </div>
  );
}
