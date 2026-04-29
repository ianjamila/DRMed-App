import { requireActiveStaff } from "@/lib/auth/require-staff";
import { Button } from "@/components/ui/button";
import { signOutStaff } from "./login/actions";

export const metadata = {
  title: "Staff dashboard — drmed.ph",
};

export default async function StaffDashboardPage() {
  const session = await requireActiveStaff();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Staff dashboard</h1>
          <p className="text-sm text-slate-600">
            Signed in as {session.full_name} ({session.role})
          </p>
        </div>
        <form action={signOutStaff}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </header>
      <p className="text-sm text-slate-700">
        Phase 4 will fill this dashboard with today&apos;s overview, queue, and
        actions.
      </p>
    </main>
  );
}
