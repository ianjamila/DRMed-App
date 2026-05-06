import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PhysicianForm } from "../physician-form";

export const metadata = { title: "New physician — staff" };

export const dynamic = "force-dynamic";

export default async function NewPhysicianPage() {
  await requireAdminStaff();
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/physicians"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Physicians
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New physician
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          After creating, edit the physician to upload a photo and set up
          their recurring schedule.
        </p>
      </header>

      <PhysicianForm />
    </div>
  );
}
