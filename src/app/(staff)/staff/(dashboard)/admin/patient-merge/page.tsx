import { requireAdminStaff } from "@/lib/auth/require-admin";
import { MergeClient } from "./merge-client";

export const metadata = {
  title: "Patient merge — staff",
};

export const dynamic = "force-dynamic";

export default async function PatientMergeAdminPage() {
  await requireAdminStaff();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Merge patient profiles
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          When a patient ends up with two rows (typo on email, name
          variation, etc.), reassign their visits and appointments to a
          single canonical record. The duplicate row is tombstoned, never
          hard-deleted, so the audit trail and old DRM-ID stay resolvable.
        </p>
      </header>

      <MergeClient />
    </div>
  );
}
