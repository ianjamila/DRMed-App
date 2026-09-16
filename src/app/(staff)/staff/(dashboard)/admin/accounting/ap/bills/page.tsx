import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { AP_INDEX_MAX_ROWS } from "@/lib/ui/table-params";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { BillsIndexClient } from "./bills-index-client";
import Link from "next/link";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/ap/bills"] };
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
      // The admin dashboard's AP card counts only bills that can take a
      // payment today, so its link has to be able to say the same thing.
      payable: sp.payable === "1",
      overdue_before: sp.overdue === "1" ? todayManilaISODate() : undefined,
      date_from: sp.date_from,
      date_to: sp.date_to,
      has_wt: sp.has_wt === "1",
      search: sp.q,
      // Was 50, which the page then paged through client-side — so the pager
      // read "of 50" no matter how many bills actually matched, and the rest
      // were unreachable with nothing on screen saying so. AP_INDEX_MAX_ROWS
      // is PostgREST's own per-response ceiling, and the client shows a
      // truncation notice on the (currently hypothetical) day it is reached.
      limit: AP_INDEX_MAX_ROWS,
    }),
    listVendorsAction({ active: true }),
  ]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageHeader
            eyebrow={SECTION_NAME["/staff/admin/accounting/ap"]}
            title={ROUTE_NAME["/staff/admin/accounting/ap/bills"]}
            subtitle={<>Invoices with a due date. For expenses already paid (cash, GCash, or
            the owner&apos;s own pocket), use <strong>Quick expense</strong> instead.</>}
          />
        </div>
        <Link
          href="/staff/admin/accounting/ap/bills/new"
          className="min-h-[44px] shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New bill
        </Link>
      </div>

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
