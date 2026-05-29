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
        Download your monthly bank statement from BPI / BDO online banking
        (or any other bank), open it in Excel, and save as CSV. Then paste the
        contents below — the system will try to match each line to a journal
        entry you already booked. Lines that don&apos;t match (bank fees,
        missed entries) get flagged so you can clean them up. Read the field
        guide further down on this page if you&apos;re unsure how to format the CSV.
      </p>

      <div className="mt-6">
        <UploadForm
          accounts={accounts ?? []}
          today={todayManilaISODate()}
        />
      </div>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          CSV field guide (click to expand)
        </summary>
        <div className="mt-3 space-y-2 text-xs text-[color:var(--color-brand-text)]">
          <p><strong>Required columns (must be in the header row):</strong></p>
          <ul className="ml-5 list-disc space-y-1">
            <li><code>date</code> — the transaction date (also accepted: <code>transaction_date</code>).</li>
            <li><code>amount</code> — the peso amount, signed: <strong>positive</strong> if money came IN (deposit), <strong>negative</strong> if money went OUT (withdrawal, bank fee). Also accepted: <code>amount_php</code>.</li>
          </ul>
          <p className="pt-2"><strong>Optional but helpful columns:</strong></p>
          <ul className="ml-5 list-disc space-y-1">
            <li><code>description</code> — what the bank labeled the transaction (e.g., &quot;POS purchase&quot;, &quot;Salary loan repay&quot;).</li>
            <li><code>reference</code> — the bank&apos;s reference number for the transaction.</li>
          </ul>
          <p className="pt-2 text-[color:var(--color-brand-text-soft)]">
            Tip: in Excel, when saving as CSV, pick &quot;CSV (Comma delimited)&quot; — not &quot;CSV UTF-8&quot; — to avoid character issues.
          </p>
        </div>
      </details>

      <details className="mt-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          Example CSV (click to expand)
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
