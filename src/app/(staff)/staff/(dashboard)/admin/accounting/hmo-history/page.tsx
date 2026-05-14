import { Suspense } from "react";

import { requireAdminStaff } from "@/lib/auth/require-admin";

import { RunsTable } from "./runs-table";
import { UploadForm } from "./upload-form";

export const metadata = { title: "HMO history import — staff" };
export const dynamic = "force-dynamic";

export default async function HmoHistoryPage() {
  await requireAdminStaff();
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.A · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          HMO history import
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Upload the DR MED MASTERSHEET workbook to load historical HMO claims into
          the subledger. After commit, new claims must be entered through the
          operational UI, not the workbook.
        </p>
      </header>

      <section className="mb-8">
        <UploadForm />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Past runs</h2>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading runs…</p>}>
          <RunsTable />
        </Suspense>
      </section>
    </div>
  );
}
