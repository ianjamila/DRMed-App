import { requireAdminStaff } from "@/lib/auth/require-admin";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { BillsIndexClient } from "./bills-index-client";
import Link from "next/link";

export const metadata = { title: "Bills — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function BillsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;

  const [bills, vendors] = await Promise.all([
    listBillsAction({
      vendor_id: sp.vendor_id,
      status: sp.status,
      date_from: sp.date_from,
      date_to: sp.date_to,
      has_wt: sp.has_wt === "1",
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
            Bills
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Vendor invoices. Drafts can be edited or deleted; posted bills can
            only be voided. WT classification is captured at the bill header
            and frozen on post.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/ap/bills/new"
          className="min-h-[44px] shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New bill
        </Link>
      </header>

      {bills.ok ? (
        <BillsIndexClient
          initialBills={bills.data}
          vendors={vendors.ok ? vendors.data.map((v) => ({ id: v.id, name: v.name })) : []}
          initialFilter={{
            vendor_id: sp.vendor_id ?? "",
            status: sp.status ?? "",
            has_wt: sp.has_wt === "1",
            q: sp.q ?? "",
          }}
        />
      ) : (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {bills.error}
        </div>
      )}
    </div>
  );
}
