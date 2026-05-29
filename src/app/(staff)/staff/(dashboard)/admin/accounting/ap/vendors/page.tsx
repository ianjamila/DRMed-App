import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { listVendorsAction } from "@/lib/actions/accounting/vendors";
import { VendorsIndexClient } from "./vendors-index-client";

export const metadata = { title: "Vendors — AP — DRMed" };
export const dynamic = "force-dynamic";

export default async function VendorsIndexPage() {
  await requireAdminStaff();
  const result = await listVendorsAction();

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.4 · Admin · AP
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Vendors
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            Suppliers we pay. Vendors are append-only — deactivate via the
            detail page rather than deleting, so historical bills retain their
            audit trail.
          </p>
        </div>
        <Link
          href="/staff/admin/accounting/ap/vendors/new"
          className="shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New vendor
        </Link>
      </header>

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
