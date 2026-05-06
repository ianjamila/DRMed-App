import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { GenerateBatchForm } from "./generate-form";

export const metadata = { title: "Generate gift codes — staff" };

export const dynamic = "force-dynamic";

export default async function GenerateBatchPage() {
  await requireAdminStaff();

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/gift-codes"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Gift codes
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Generate batch
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Mints a batch of unique GC-XXXX-YYYY-ZZZZ codes at one face value.
          Reception sells these at the counter and can redeem them on any
          future visit&apos;s payment screen.
        </p>
      </header>

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <GenerateBatchForm />
      </div>
    </div>
  );
}
