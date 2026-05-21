import { requireAdminStaff } from "@/lib/auth/require-admin";
import { listBillPaymentsAction } from "@/lib/actions/accounting/bill-payments";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { PaymentsIndexClient } from "./payments-index-client";
import Link from "next/link";

export const metadata = { title: "Payments — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function PaymentsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;

  const [payments, vendors] = await Promise.all([
    listBillPaymentsAction({
      vendor_id: sp.vendor_id,
      method: sp.method,
      date_from: sp.date_from,
      date_to: sp.date_to,
      search: sp.q,
      limit: 50,
    }),
    listVendorsAction({ active: true }),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.4 · Admin · AP
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Payments
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Outflows to vendors. Each payment may settle multiple bills via
            allocations.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/ap/payments/new"
          className="min-h-[44px] shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New payment
        </Link>
      </header>

      {payments.ok ? (
        <PaymentsIndexClient
          initialPayments={payments.data}
          vendors={vendors.ok ? vendors.data.map((v) => ({ id: v.id, name: v.name })) : []}
          initialFilter={{
            vendor_id: sp.vendor_id ?? "",
            method: sp.method ?? "",
            q: sp.q ?? "",
          }}
        />
      ) : (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {payments.error}
        </div>
      )}
    </div>
  );
}
