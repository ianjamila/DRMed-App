import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { VendorsIndexClient } from "./vendors-index-client";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/ap/vendors"] };
export const dynamic = "force-dynamic";

export default async function VendorsIndexPage() {
  await requireAdminStaff();
  const result = await listVendorsAction();

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageHeader
            eyebrow={SECTION_NAME["/staff/admin/accounting/ap"]}
            title={ROUTE_NAME["/staff/admin/accounting/ap/vendors"]}
            subtitle={<>Suppliers we pay. Vendors are append-only — deactivate via the
            detail page rather than deleting, so historical bills retain their
            audit trail.</>}
          />
        </div>
        <Link
          href="/staff/admin/accounting/ap/vendors/new"
          className="shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New vendor
        </Link>
      </div>

      {result.ok ? (
        <VendorsIndexClient initialVendors={result.data} />
      ) : (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {result.error}
        </div>
      )}
    </div>
  );
}
