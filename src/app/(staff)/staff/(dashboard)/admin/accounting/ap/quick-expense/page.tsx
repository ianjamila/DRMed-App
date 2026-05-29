import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { QuickExpenseForm } from "./quick-expense-form";

export const metadata = { title: "Quick expense — DRMed" };
export const dynamic = "force-dynamic";

export default async function QuickExpensePage() {
  await requireAdminStaff();
  const today = todayManilaISODate();

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Admin · Bills
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Quick expense
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Record an expense that was already paid (cash, GCash, BPI, or the owner&apos;s own pocket). Posts a
          balanced journal entry in one step — no vendor account, no due date.
          For invoices with a due date, use{" "}
          <strong>Vendor bills</strong> instead.
        </p>
      </header>

      <QuickExpenseForm defaultDate={today} />
    </div>
  );
}
