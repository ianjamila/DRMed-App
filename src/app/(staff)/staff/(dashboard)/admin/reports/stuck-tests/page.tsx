import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/staff/page-header";

export const metadata = { title: "Stuck tests — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ days?: string }>;
}

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  result_uploaded: "bg-amber-100 text-amber-900",
  ready_for_release: "bg-emerald-100 text-emerald-900",
};

const PAYMENT_STYLE: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-emerald-100 text-emerald-900",
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
};

interface StuckRow {
  id: string;
  status: string;
  requested_at: string;
  assigned_to: string | null;
  visit_id: string;
  services:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
  visits:
    | {
        visit_number: string;
        payment_status: string;
        patients:
          | { first_name: string; last_name: string; drm_id: string }
          | { first_name: string; last_name: string; drm_id: string }[]
          | null;
      }
    | {
        visit_number: string;
        payment_status: string;
        patients:
          | { first_name: string; last_name: string; drm_id: string }
          | { first_name: string; last_name: string; drm_id: string }[]
          | null;
      }[]
    | null;
}

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function ageDays(requestedAt: string): number {
  return Math.floor(
    (Date.now() - new Date(requestedAt).getTime()) / (1000 * 60 * 60 * 24),
  );
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function manila(ts: string): string {
  return new Date(ts).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

export default async function StuckTestsPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const daysRaw = Number(params.days);
  const days =
    Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 365
      ? Math.floor(daysRaw)
      : 3;

  const admin = createAdminClient();
  const cutoff = cutoffIso(days);

  // Non-final tests older than the threshold. No direct patients embed on
  // test_requests — join via visits(patients(...)).
  const { data: stuckRaw } = await admin
    .from("test_requests")
    .select(
      `
        id, status, requested_at, assigned_to, visit_id,
        services!inner ( code, name ),
        visits!inner (
          visit_number, payment_status,
          patients!inner ( first_name, last_name, drm_id )
        )
      `,
    )
    .in("status", [
      "requested",
      "in_progress",
      "result_uploaded",
      "ready_for_release",
    ])
    .eq("is_package_header", false)
    .lt("requested_at", cutoff)
    // A deleted line isn't stuck — it's not owed at all (0125).
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .limit(500);

  const stuck = (stuckRaw ?? []) as StuckRow[];

  // Resolve claimer names in one query.
  const claimerIds = Array.from(
    new Set(stuck.map((r) => r.assigned_to).filter((v): v is string => !!v)),
  );
  const claimerNames = new Map<string, string>();
  if (claimerIds.length > 0) {
    const { data: profs } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", claimerIds);
    for (const p of profs ?? []) claimerNames.set(p.id, p.full_name);
  }

  // Second table: package HEADERS sitting at ready_for_release on paid
  // visits whose components are all terminal with ≥1 released — the Visit
  // #0037 class. Post-0109 (header auto-release) this should always be
  // empty; anything here means the auto-release didn't fire — investigate.
  const { data: headersRaw } = await admin
    .from("test_requests")
    .select(
      `
        id, status, requested_at, visit_id,
        services!inner ( code, name ),
        visits!inner (
          visit_number, payment_status,
          patients!inner ( first_name, last_name, drm_id )
        )
      `,
    )
    .eq("is_package_header", true)
    .eq("status", "ready_for_release")
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .limit(100);

  const headerCandidates = ((headersRaw ?? []) as StuckRow[]).filter((h) => {
    const visit = pluckOne(h.visits);
    return (
      visit?.payment_status === "paid" || visit?.payment_status === "waived"
    );
  });

  // Check component states for each candidate header (bounded: candidates
  // should be ~0 in a healthy system).
  const stuckHeaders: StuckRow[] = [];
  if (headerCandidates.length > 0) {
    const { data: components } = await admin
      .from("test_requests")
      .select("parent_id, status")
      .in(
        "parent_id",
        headerCandidates.map((h) => h.id),
      );
    const byParent = new Map<string, string[]>();
    for (const c of components ?? []) {
      if (!c.parent_id) continue;
      const list = byParent.get(c.parent_id) ?? [];
      list.push(c.status);
      byParent.set(c.parent_id, list);
    }
    for (const h of headerCandidates) {
      const statuses = byParent.get(h.id) ?? [];
      const allTerminal =
        statuses.length > 0 &&
        statuses.every((s) => s === "released" || s === "cancelled");
      const anyReleased = statuses.some((s) => s === "released");
      if (allTerminal && anyReleased) stuckHeaders.push(h);
    }
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Stuck tests"
        subtitle={`Tests sitting longer than ${days} day${days === 1 ? "" : "s"} in any non-final state — unclaimed, in progress, or ready but unreleased — so nothing silently stalls.`}
        actions={
          <form method="GET" className="flex items-center gap-2 text-sm">
            <label
              htmlFor="days"
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
            >
              Older than
            </label>
            <input
              id="days"
              type="number"
              name="days"
              min={1}
              max={365}
              defaultValue={days}
              className="w-20 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
            />
            <span className="text-xs text-[color:var(--color-brand-text-soft)]">
              days
            </span>
            <button
              type="submit"
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white hover:opacity-90"
            >
              Apply
            </button>
          </form>
        }
      />

      {stuck.length === 500 ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the oldest 500 rows — there may be more. Raise the day
          threshold to narrow the list.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Age</th>
              <th className="px-4 py-3">Visit</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Claimed by</th>
              <th className="px-4 py-3">Visit payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {stuck.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  Nothing stuck older than {days} day{days === 1 ? "" : "s"}. 🎉
                </td>
              </tr>
            ) : (
              stuck.map((r) => {
                const svc = pluckOne(r.services);
                const visit = pluckOne(r.visits);
                const patient = visit ? pluckOne(visit.patients) : null;
                return (
                  <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {ageDays(r.requested_at)}d
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {manila(r.requested_at)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/visits/${r.visit_id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        #{visit?.visit_number ?? "?"}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {patient
                          ? `${patient.last_name}, ${patient.first_name}`
                          : "—"}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {patient?.drm_id ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/queue/${r.id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {svc?.name ?? "(unknown)"}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {svc?.code ?? "—"}
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
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {r.assigned_to
                        ? (claimerNames.get(r.assigned_to) ?? "—")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          PAYMENT_STYLE[visit?.payment_status ?? ""] ?? ""
                        }`}
                      >
                        {(visit?.payment_status ?? "—").replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      <section className="mt-8">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Package headers that should have auto-released
        </h2>
        <p className="mb-3 text-sm text-[color:var(--color-brand-text-soft)]">
          Headers still at &quot;ready for release&quot; on a paid visit with
          every component finished and at least one released — the class of
          stall Visit #0037 hit. Since the auto-release fix this list should
          always be empty; anything appearing here means the auto-release
          didn&apos;t fire — investigate.
        </p>
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Visit</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Package</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {stuckHeaders.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    None — header auto-release is working.
                  </td>
                </tr>
              ) : (
                stuckHeaders.map((h) => {
                  const svc = pluckOne(h.services);
                  const visit = pluckOne(h.visits);
                  const patient = visit ? pluckOne(visit.patients) : null;
                  return (
                    <tr key={h.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {ageDays(h.requested_at)}d
                        </p>
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {manila(h.requested_at)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${h.visit_id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{visit?.visit_number ?? "?"}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patient
                            ? `${patient.last_name}, ${patient.first_name}`
                            : "—"}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {patient?.drm_id ?? "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/queue/${h.id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {svc?.name ?? "(unknown)"}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {svc?.code ?? "—"}
                        </p>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>
      </section>
    </div>
  );
}
