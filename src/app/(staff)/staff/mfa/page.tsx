import { redirect } from "next/navigation";
import { requireSignedInStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { signOutStaff } from "../login/actions";
import { Button } from "@/components/ui/button";
import { EnrollForm } from "./enroll-form";
import { ChallengeForm } from "./challenge-form";

export const metadata = {
  title: "Two-factor authentication — staff",
};

export const dynamic = "force-dynamic";

export default async function StaffMfaPage() {
  const session = await requireSignedInStaff();
  const supabase = await createClient();

  // If the user already cleared MFA this session, send them on. Avoids
  // landing here after a Back-button.
  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.currentLevel === "aal2") {
    redirect("/staff");
  }

  const { data: factors } = await supabase.auth.mfa.listFactors();
  // factors.totp is verified TOTP factors only (Supabase types).
  const verified = factors?.totp?.[0];

  // Verified factor → user is between password and code step. Show challenge.
  // No verified factor → enrollment screen (admin: required; others: optional
  // but we still got here so something asked us to enroll — typically the
  // user clicked the "Set up MFA" link from a future profile page).
  const mode: "challenge" | "enroll" = verified ? "challenge" : "enroll";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          drmed.staff · {session.role}
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          Two-factor authentication
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          Signed in as <span className="font-mono">{session.email}</span>.
        </p>
      </header>

      {mode === "enroll" ? (
        <EnrollForm role={session.role} />
      ) : (
        <ChallengeForm />
      )}

      <form action={signOutStaff} className="mt-8">
        <Button type="submit" variant="outline" className="w-full text-xs">
          Cancel and sign out
        </Button>
      </form>
    </main>
  );
}
