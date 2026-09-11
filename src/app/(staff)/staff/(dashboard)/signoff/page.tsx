import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export const metadata = {
  title: "Sign-off — staff",
};

export default async function SignoffPage() {
  await requireActiveStaff();
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Sign-off
      </h1>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
        Pathologist sign-off lands here once it&apos;s built. The option to
        require it on a service is locked off for now on the{" "}
        <Link
          href="/staff/services"
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          service edit page
        </Link>{" "}
        — turning it on before this screen exists would strand results
        waiting for a sign-off that never happens.
      </p>
      <p className="mt-4 text-sm text-[color:var(--color-brand-text-soft)]">
        UI to come — wiring this up is queued for a later phase.
      </p>
    </div>
  );
}
