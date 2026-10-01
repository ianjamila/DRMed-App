import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { MergeClient } from "./merge-client";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = {
  title: ROUTE_NAME["/staff/admin/patient-merge"],
};

export const dynamic = "force-dynamic";

export default async function PatientMergeAdminPage() {
  await requireAdminStaff();

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {ROUTE_NAME["/staff/admin/patient-merge"]}
          </h1>
          <Link href="/staff/admin/patient-merge/candidates" className="text-sm font-semibold text-cyan-700 hover:underline">
            View possible duplicates →
          </Link>
        </div>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          When a patient ends up with two records (a typo in the email, a name variation…), move their visits,
          appointments, results, consent records and lab-request uploads onto one record. The other record stays on
          file pointing at the one you keep, so its old DRM-ID and the audit trail still resolve. Undo is available
          for 30 days.
        </p>
      </header>

      <MergeClient />
    </div>
  );
}
