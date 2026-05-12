import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { CoaListClient } from "./coa-list-client";

export const metadata = { title: "Chart of accounts — staff" };
export const dynamic = "force-dynamic";

const TYPE_ORDER: Record<string, number> = {
  asset: 1,
  liability: 2,
  equity: 3,
  revenue: 4,
  contra_revenue: 5,
  expense: 6,
  contra_expense: 7,
  memo: 8,
};

const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  contra_revenue: "Contra-revenue",
  expense: "Expenses",
  contra_expense: "Contra-expense",
  memo: "Memo / Suspense",
};

export default async function ChartOfAccountsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type, parent_id, normal_balance, is_active, description")
    .order("code", { ascending: true });

  const rows = (accounts ?? []).map((a) => ({
    ...a,
    typeOrder: TYPE_ORDER[a.type] ?? 99,
    typeLabel: TYPE_LABEL[a.type] ?? a.type,
  }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.1 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Chart of accounts
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            The general-ledger account list. Accounts are append-only — codes
            are stable identifiers and inactive accounts soft-disable rather
            than delete.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/chart-of-accounts/new"
          className="shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New account
        </Link>
      </header>

      <CoaListClient rows={rows} />
    </div>
  );
}
