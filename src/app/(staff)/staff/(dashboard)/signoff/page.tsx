import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export const metadata = {
  title: "Sign-off — staff",
};

export default async function SignoffPage() {
  await requireActiveStaff();
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Sign-off
      </h1>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
        Pathologist sign-off lands here. It only fires when a service has{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          requires_signoff = true
        </code>
        . Defaults are off; flip it on a service in{" "}
        <Link
          href="/staff/services"
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          /staff/services
        </Link>{" "}
        to enable.
      </p>
      <p className="mt-4 text-sm text-[color:var(--color-brand-text-soft)]">
        UI to come — wiring this up is queued for a later phase.
      </p>
    </div>
  );
}
