import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Upload bank statement — staff" };
export const dynamic = "force-dynamic";

export default async function UploadBankStatementPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // Cash accounts are 1010, 1020, 1021, 1030 by COA convention.
  const { data: accounts } = await admin
    .from("chart_of_accounts")
    .select("id, code, name")
    .eq("type", "asset")
    .in("code", ["1010", "1020", "1021", "1030"])
    .order("code");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/accounting/bank-rec"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Bank reconciliation
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Upload bank statement
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Paste the statement as CSV. Required header columns: <code>date</code>{" "}
        (or <code>transaction_date</code>) and <code>amount</code> (or{" "}
        <code>amount_php</code>). Optional: <code>description</code>,{" "}
        <code>reference</code>. Positive amounts = inflow (deposit); negative
        amounts = outflow (withdrawal/fee).
      </p>

      <div className="mt-6">
        <UploadForm
          accounts={accounts ?? []}
          today={todayManilaISODate()}
        />
      </div>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          Example CSV
        </summary>
        <pre className="mt-3 overflow-x-auto rounded-md bg-[color:var(--color-brand-bg)] p-3 text-xs">
{`date,description,reference,amount
2026-05-15,Deposit at branch,DEP-001234,15000.00
2026-05-16,POS purchase Mercury Drug,POS-998877,-450.00
2026-05-17,Online transfer to BIR,REF-558899,-2500.00`}
        </pre>
      </details>
    </div>
  );
}
