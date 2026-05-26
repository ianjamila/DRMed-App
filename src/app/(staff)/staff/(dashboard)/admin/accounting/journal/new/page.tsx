import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { ManualJeForm } from "./manual-je-form";

export const metadata = { title: "New journal entry — staff" };
export const dynamic = "force-dynamic";

export default async function NewJournalEntryPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type, normal_balance")
    .eq("is_active", true)
    .order("code");

  const today = todayManilaISODate();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/accounting/periods"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Accounting periods
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New journal entry
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Manual posting. Entry number is allocated automatically. The system
        blocks postings into closed periods and requires debits = credits
        before flipping a draft to posted.
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
        />
      </div>
    </div>
  );
}
