import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import { signOutPatient } from "./login/actions";

export const metadata = {
  title: "Your results — drmed.ph",
};

export default async function PatientPortalPage() {
  const session = await getPatientSession();
  if (!session) {
    // Middleware should have caught this, but guard anyway.
    redirect("/portal/login");
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your results</h1>
          <p className="text-sm text-slate-600">
            Signed in as {session.drm_id}
          </p>
        </div>
        <form action={signOutPatient}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </header>
      <p className="text-sm text-slate-700">
        Phase 5 will list your visits and released results here.
      </p>
    </main>
  );
}
