import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOutPatient } from "@/app/(patient)/portal/login/actions";
import type { PatientProfile } from "@/lib/auth/require-patient";

interface Props {
  patient: PatientProfile;
  children: React.ReactNode;
}

export function PatientShell({ patient, children }: Props) {
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--color-brand-bg)]">
      <header className="border-b border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/portal"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold tracking-tight text-[color:var(--color-brand-navy)]"
          >
            drmed<span className="text-[color:var(--color-brand-cyan)]">.portal</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/portal/help"
              className="font-semibold text-[color:var(--color-brand-text-mid)] hover:text-[color:var(--color-brand-cyan)]"
            >
              Help
            </Link>
            <form action={signOutPatient}>
              <Button type="submit" variant="outline" className="text-xs">
                Sign out
              </Button>
            </form>
          </nav>
        </div>
        <div className="mx-auto max-w-5xl border-t border-[color:var(--color-brand-bg-mid)] px-4 py-3 sm:px-6 lg:px-8">
          <p className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
            {patient.middle_name ? ` ${patient.middle_name}` : ""}
          </p>
          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
            {patient.drm_id}
          </p>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-[color:var(--color-brand-bg-mid)] bg-white py-4 text-center text-xs text-[color:var(--color-brand-text-soft)]">
        🔒 Protected under the Philippine Data Privacy Act (RA 10173).
      </footer>
    </div>
  );
}
