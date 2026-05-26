import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Dashboard — staff",
};

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
}

function StatCard({ label, value, hint, href }: StatCardProps) {
  const body = (
    <>
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
    </>
  );

  const baseClass =
    "block rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5";

  if (href) {
    return (
      <Link
        href={href}
        className={`${baseClass} transition-colors hover:border-[color:var(--color-brand-cyan)] hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]`}
      >
        {body}
      </Link>
    );
  }

  return <article className={baseClass}>{body}</article>;
}

async function loadStats() {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const startOfTodayIso = `${today}T00:00:00.000Z`;
  const endOfTodayIso = `${today}T23:59:59.999Z`;

  const [
    { count: visitsToday },
    { count: queueSize },
    { count: pendingRelease },
    { count: releasedToday },
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
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "released")
      .gte("released_at", startOfTodayIso)
      .lt("released_at", endOfTodayIso),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .gte("scheduled_at", startOfTodayIso)
      .lt("scheduled_at", endOfTodayIso)
      .in("status", ["confirmed", "arrived"]),
  ]);

  return {
    visitsToday: visitsToday ?? 0,
    queueSize: queueSize ?? 0,
    pendingRelease: pendingRelease ?? 0,
    releasedToday: releasedToday ?? 0,
    appointmentsToday: appointmentsToday ?? 0,
  };
}

export default async function StaffDashboardPage() {
  const session = await requireActiveStaff();
  const stats = await loadStats();

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          Welcome back, {session.full_name.split(" ")[0]}
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Today&apos;s overview
        </h1>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Visits today"
          value={stats.visitsToday}
          hint="Patients registered today"
          href="/staff/visits"
        />
        <StatCard
          label="Queue size"
          value={stats.queueSize}
          hint="Tests requested or in progress"
          href="/staff/queue"
        />
        <StatCard
          label="Pending release"
          value={stats.pendingRelease}
          hint="Results ready, awaiting payment + release"
          href="/staff/queue?filter=pending_release"
        />
        <StatCard
          label="Released today"
          value={stats.releasedToday}
          hint="Tests released to patients today"
          href="/staff/queue?filter=released_today"
        />
        <StatCard
          label="Appointments today"
          value={stats.appointmentsToday}
          hint="Confirmed / arrived"
          href="/staff/appointments"
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
