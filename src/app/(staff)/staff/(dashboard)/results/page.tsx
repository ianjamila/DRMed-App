import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { sectionsForRole } from "@/lib/auth/role-sections";

export const metadata = { title: "Results — staff" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const STATUSES = ["all", "released", "ready", "in_progress", "cancelled"] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "All",
  released: "Released",
  ready: "Ready for release",
  in_progress: "In progress",
  cancelled: "Cancelled",
};

// Status values come from test_requests.status. Map filter → underlying values.
const STATUS_FILTER_TO_DB: Record<Exclude<StatusFilter, "all">, string[]> = {
  released: ["released"],
  ready: ["result_uploaded", "ready_for_release"],
  in_progress: ["requested", "in_progress"],
  cancelled: ["cancelled"],
};

const STATUS_BADGE: Record<string, string> = {
  released: "bg-emerald-50 text-emerald-700 border-emerald-200",
  result_uploaded: "bg-sky-50 text-sky-700 border-sky-200",
  ready_for_release: "bg-sky-50 text-sky-700 border-sky-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  requested: "bg-slate-50 text-slate-700 border-slate-200",
  cancelled: "bg-red-50 text-red-700 border-red-200",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SearchProps {
  searchParams: Promise<{
    status?: string;
    start?: string;
    end?: string;
    q?: string;
    page?: string;
  }>;
}

interface ResultRow {
  id: string;
  status: string;
  released_at: string | null;
  completed_at: string | null;
  requested_at: string;
  visits: {
    id: string;
    visit_number: string;
    patients: { first_name: string; last_name: string; drm_id: string } | null;
  } | null;
  services: { code: string; name: string; kind: string; section: string | null } | null;
}

export default async function AllResultsPage({ searchParams }: SearchProps) {
  const staff = await requireActiveStaff();
  const allowedSections = sectionsForRole(staff.role); // null = unrestricted
  const sp = await searchParams;

  const status: StatusFilter = STATUSES.includes(sp.status as StatusFilter)
    ? (sp.status as StatusFilter)
    : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const todayISO = todayManilaISODate();
  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : "";
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : "";
  const q = sp.q?.trim() ?? "";

  const admin = createAdminClient();

  let query = admin
    .from("test_requests")
    .select(
      `
        id, status, released_at, completed_at, requested_at,
        visits!inner ( id, visit_number, patients!inner ( first_name, last_name, drm_id ) ),
        services!inner ( code, name, kind, section )
      `,
      { count: "exact" },
    )
    .order("requested_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (status !== "all") {
    query = query.in("status", STATUS_FILTER_TO_DB[status]);
  }
  if (start) query = query.gte("requested_at", `${start}T00:00:00`);
  if (end) query = query.lte("requested_at", `${end}T23:59:59`);

  // Section gate per role: admin + pathologist see everything (null), medtech
  // sees lab-bench sections, xray sees imaging sections, reception sees nothing.
  if (allowedSections !== null) {
    if (allowedSections.length === 0) {
      // Force empty result set without breaking the query shape.
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("services.section", allowedSections);
    }
  }

  const { data, count } = await query.returns<ResultRow[]>();
  const rows = data ?? [];

  // Pull which test_requests have a stored PDF — junction → results.storage_path.
  // One query for the visible page, keyed by test_request_id.
  const trIds = rows.map((r) => r.id);
  const hasPdfByTrId = new Map<string, boolean>();
  if (trIds.length > 0) {
    const { data: links } = await admin
      .from("result_test_requests")
      .select("test_request_id, results!inner ( storage_path )")
      .in("test_request_id", trIds);
    for (const link of links ?? []) {
      const result = (link as { results: { storage_path: string | null } | { storage_path: string | null }[] | null }).results;
      const resolved = Array.isArray(result) ? result[0] : result;
      if (resolved?.storage_path) {
        hasPdfByTrId.set(link.test_request_id as string, true);
      }
    }
  }

  // Optional client-side filter when q is set. Server-side ilike across a join
  // is awkward in PostgREST, so post-filter the page rows here.
  const filtered = q
    ? rows.filter((r) => {
        const pat = r.visits?.patients;
        const name = pat ? `${pat.first_name} ${pat.last_name}`.toLowerCase() : "";
        const drm = pat?.drm_id?.toLowerCase() ?? "";
        const svc = `${r.services?.code ?? ""} ${r.services?.name ?? ""}`.toLowerCase();
        const ql = q.toLowerCase();
        return name.includes(ql) || drm.includes(ql) || svc.includes(ql);
      })
    : rows;

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const base: Record<string, string> = {
      status: status === "all" ? "" : status,
      start,
      end,
      q,
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `/staff/results${qs ? `?${qs}` : ""}`;
  }

  const hasFilters = Boolean(start || end || q || status !== "all");

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Results
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Archive of every test request — created, in progress, ready for
          release, released, or cancelled.
          {hasFilters ? ` · ${total} matching` : ` · ${total} total`}
        </p>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => {
          const active = s === status;
          return (
            <Link
              key={s}
              href={buildHref({ status: s === "all" ? "" : s, page: null })}
              className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {STATUS_LABEL[s]}
            </Link>
          );
        })}
      </nav>

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        action="/staff/results"
      >
        <input type="hidden" name="status" value={status === "all" ? "" : status} />
        <div className="flex flex-col">
          <label htmlFor="start" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Requested from
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor="end" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            …to
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col sm:col-span-2">
          <label htmlFor="q" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Patient / service search
          </label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. Castillo, CBC, DRM-2024-0123"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-full flex flex-wrap gap-2">
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Apply
          </button>
          {hasFilters ? (
            <Link
              href="/staff/results"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No results match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Tests</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Requested</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3">Released</th>
                  <th className="px-4 py-3">PDF</th>
                  <th className="px-4 py-3 text-right">Visit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {groupByVisit(filtered, hasPdfByTrId).map((g) => {
                  const pat = g.patient;
                  const patientLabel = pat
                    ? `${pat.last_name}, ${pat.first_name}`
                    : "—";
                  const statusSummary = summarizeStatuses(g.tests.map((t) => t.status));
                  return (
                    <tr key={g.visitId} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[color:var(--color-brand-navy)]">
                          {patientLabel}
                        </div>
                        {pat ? (
                          <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {pat.drm_id}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-0.5">
                          {g.tests.map((t) => (
                            <div key={t.id}>
                              <span className="font-mono text-[color:var(--color-brand-text-soft)]">
                                {t.code}
                              </span>{" "}
                              {t.name}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {statusSummary.kind === "uniform" ? (
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[statusSummary.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
                          >
                            {statusSummary.status}
                          </span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {statusSummary.entries.map((e) => (
                              <span
                                key={e.status}
                                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[e.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
                              >
                                {e.status} × {e.count}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {formatDateTime(g.requestedAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.completedAt ? formatDateTime(g.completedAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {g.releasedAt ? formatDateTime(g.releasedAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-col gap-0.5">
                          {g.tests.map((t) =>
                            t.hasPdf ? (
                              <a
                                key={t.id}
                                href={`/staff/results/${t.id}/pdf`}
                                target="_blank"
                                rel="noopener"
                                className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                              >
                                {t.code} PDF →
                              </a>
                            ) : (
                              <span
                                key={t.id}
                                className="text-[color:var(--color-brand-text-soft)]"
                              >
                                {t.code} —
                              </span>
                            ),
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-xs">
                        <Link
                          href={`/staff/visits/${g.visitId}`}
                          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          {g.visitNumber}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {totalPages > 1 ? (
        <nav className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            Page {safePage} of {totalPages}
          </p>
          <div className="flex gap-2">
            {safePage > 1 ? (
              <Link
                href={buildHref({ page: String(safePage - 1) })}
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
              >
                ← Previous
              </Link>
            ) : (
              <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                ← Previous
              </span>
            )}
            {safePage < totalPages ? (
              <Link
                href={buildHref({ page: String(safePage + 1) })}
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
              >
                Next →
              </Link>
            ) : (
              <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                Next →
              </span>
            )}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VisitGroup {
  visitId: string;
  visitNumber: string;
  patient: { first_name: string; last_name: string; drm_id: string } | null;
  tests: { id: string; status: string; code: string; name: string; hasPdf: boolean }[];
  requestedAt: string;
  completedAt: string | null;
  releasedAt: string | null;
}

function groupByVisit(rows: ResultRow[], hasPdfByTrId: Map<string, boolean>): VisitGroup[] {
  const groups = new Map<string, VisitGroup>();
  for (const r of rows) {
    const visit = r.visits;
    if (!visit) continue;
    const existing = groups.get(visit.id);
    const test = {
      id: r.id,
      status: r.status,
      code: r.services?.code ?? "—",
      name: r.services?.name ?? "",
      hasPdf: hasPdfByTrId.get(r.id) === true,
    };
    if (existing) {
      existing.tests.push(test);
      // earliest requested, latest completed/released across the visit
      if (r.requested_at < existing.requestedAt) existing.requestedAt = r.requested_at;
      if (r.completed_at && (!existing.completedAt || r.completed_at > existing.completedAt)) {
        existing.completedAt = r.completed_at;
      }
      if (r.released_at && (!existing.releasedAt || r.released_at > existing.releasedAt)) {
        existing.releasedAt = r.released_at;
      }
    } else {
      groups.set(visit.id, {
        visitId: visit.id,
        visitNumber: visit.visit_number,
        patient: visit.patients,
        tests: [test],
        requestedAt: r.requested_at,
        completedAt: r.completed_at,
        releasedAt: r.released_at,
      });
    }
  }
  // newest first by requested_at
  return Array.from(groups.values()).sort((a, b) =>
    a.requestedAt < b.requestedAt ? 1 : -1,
  );
}

type StatusSummary =
  | { kind: "uniform"; status: string }
  | { kind: "mixed"; entries: { status: string; count: number }[] };

function summarizeStatuses(statuses: string[]): StatusSummary {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  if (counts.size === 1) {
    return { kind: "uniform", status: statuses[0] };
  }
  // Most-progressed first so the user reads the headline status at a glance.
  const order = ["released", "ready_for_release", "result_uploaded", "in_progress", "requested", "cancelled"];
  const entries = Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return { kind: "mixed", entries };
}

function formatDateTime(iso: string): string {
  // e.g. "5/28/2026, 11:42 AM"
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "short",
    timeStyle: "short",
  });
}
