import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { queueTitleForRole, sectionsForRole } from "@/lib/auth/role-sections";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { ClaimButton } from "./claim-button";

export const metadata = {
  title: "Queue — staff",
};

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
};

interface SearchProps {
  searchParams: Promise<{ filter?: "mine" | "all" }>;
}

export default async function QueuePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const filter = params.filter ?? "all";

  const session = await requireActiveStaff();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Each role sees only the sections it operates on. medtech doesn't see
  // imaging_xray (handled by xray_technician), and vice versa. admin /
  // pathologist see everything.
  const allowedSections = sectionsForRole(session.role);

  let query = supabase
    .from("test_requests")
    .select(
      `
        id, status, requested_at, assigned_to, started_at,
        services!inner ( id, code, name, turnaround_hours, section ),
        visits!inner (
          id, visit_number,
          patients!inner ( id, drm_id, first_name, last_name )
        )
      `,
    )
    .in("status", ["requested", "in_progress"])
    .order("requested_at", { ascending: true })
    .limit(100);

  if (allowedSections !== null && allowedSections.length > 0) {
    query = query.in("services.section", allowedSections);
  }

  if (filter === "mine" && user) {
    query = query.eq("assigned_to", user.id);
  }

  const { data: rows } = await query;
  const queueTitle = queueTitleForRole(session.role);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="queue-page"
        subscriptions={[
          { table: "test_requests", event: "INSERT" },
          { table: "test_requests", event: "UPDATE" },
        ]}
      />
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {queueTitle}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Tests requested or in progress, oldest first.
          </p>
        </div>
        <nav className="flex gap-2 text-sm">
          <FilterTab href="/staff/queue" label="All" active={filter === "all"} />
          <FilterTab
            href="/staff/queue?filter=mine"
            label="Mine"
            active={filter === "mine"}
          />
        </nav>
      </header>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {(rows ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  Queue is empty.
                </td>
              </tr>
            ) : (
              (rows ?? []).map((r) => {
                const svc = Array.isArray(r.services) ? r.services[0] : r.services;
                const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
                if (!svc || !visit) return null;
                const patient = Array.isArray(visit.patients)
                  ? visit.patients[0]
                  : visit.patients;
                if (!patient) return null;
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {new Date(r.requested_at).toLocaleString("en-PH")}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/queue/${r.id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {patient.last_name}, {patient.first_name}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {patient.drm_id} · Visit #{visit.visit_number}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {svc.name}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {svc.code}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[r.status] ?? ""
                        }`}
                      >
                        {r.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "requested" ? (
                        <ClaimButton testRequestId={r.id} navigateOnClaim />
                      ) : (
                        <Link
                          href={`/staff/queue/${r.id}`}
                          className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          Open →
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 font-semibold ${
        active
          ? "bg-[color:var(--color-brand-navy)] text-white"
          : "border border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
      }`}
    >
      {label}
    </Link>
  );
}
