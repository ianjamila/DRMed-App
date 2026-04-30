import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ImportPatientsForm } from "./import-form";

export const metadata = {
  title: "Import patients — staff",
};

export default async function ImportPatientsPage() {
  await requireAdminStaff();
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Import patients
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-mid)]">
        One-time migration tool. Paste a CSV exported from your existing
        Google Sheet (or any spreadsheet) and we&apos;ll bulk-create patient
        records. Each row gets a fresh DRM-ID. Rows that fail validation are
        listed below with the reason — fix and re-paste those rows separately.
      </p>

      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <ImportPatientsForm />
      </div>

      <div className="mt-6 rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-5 text-sm text-[color:var(--color-brand-text-mid)]">
        <p className="font-bold text-[color:var(--color-brand-navy)]">
          Tips
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Birthdate accepts <code>YYYY-MM-DD</code>,{" "}
            <code>MM/DD/YYYY</code>, or <code>YYYY/MM/DD</code>.
          </li>
          <li>
            Sex accepts <code>male</code>, <code>female</code>,{" "}
            <code>M</code>, or <code>F</code> (case-insensitive). Blank is
            allowed.
          </li>
          <li>
            Imports are append-only. To re-run for the same set, export the
            sheet again excluding rows already in <code>/staff/patients</code>.
          </li>
          <li>
            Every import is recorded in the audit log (
            <Link
              href="/staff/audit?action=patients."
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              patients.bulk_imported
            </Link>
            ).
          </li>
        </ul>
      </div>
    </div>
  );
}
