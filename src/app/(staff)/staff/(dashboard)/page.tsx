import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Dashboard — staff",
};

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
}

function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </p>
      ) : null}
    </article>
  );
}

async function loadStats() {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const [
    { count: visitsToday },
    { count: queueSize },
    { count: pendingRelease },
    { count: appointmentsToday },
  ] = await Promise.all([
    supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("visit_date", today),
    supabase
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .in("status", ["requested", "in_progress"]),
    supabase
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "ready_for_release"),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .gte("scheduled_at", `${today}T00:00:00.000Z`)
      .lt("scheduled_at", `${today}T23:59:59.999Z`)
      .in("status", ["confirmed", "arrived"]),
  ]);

  return {
    visitsToday: visitsToday ?? 0,
    queueSize: queueSize ?? 0,
    pendingRelease: pendingRelease ?? 0,
    appointmentsToday: appointmentsToday ?? 0,
  };
}

export default async function StaffDashboardPage() {
  const session = await requireActiveStaff();
  const stats = await loadStats();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          Welcome back, {session.full_name.split(" ")[0]}
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Today&apos;s overview
        </h1>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Visits today"
          value={stats.visitsToday}
          hint="Patients registered today"
        />
        <StatCard
          label="Queue size"
          value={stats.queueSize}
          hint="Tests requested or in progress"
        />
        <StatCard
          label="Pending release"
          value={stats.pendingRelease}
          hint="Results ready, awaiting payment + release"
        />
        <StatCard
          label="Appointments today"
          value={stats.appointmentsToday}
          hint="Confirmed / arrived"
        />
      </div>

      <p className="mt-8 text-sm text-[color:var(--color-brand-text-soft)]">
        Phase 4 builds out the operational pages from the sidebar. Use the nav
        to access patient registration, the lab queue, and admin tools by
        role.
      </p>
    </div>
  );
}
