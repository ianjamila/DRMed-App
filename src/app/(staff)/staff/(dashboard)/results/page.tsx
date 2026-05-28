import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "All results — staff" };
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
  ready: ["completed", "signed_off"],
  in_progress: ["requested", "in_progress"],
  cancelled: ["cancelled"],
};

const STATUS_BADGE: Record<string, string> = {
  released: "bg-emerald-50 text-emerald-700 border-emerald-200",
  completed: "bg-sky-50 text-sky-700 border-sky-200",
  signed_off: "bg-sky-50 text-sky-700 border-sky-200",
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
  services: { code: string; name: string; kind: string } | null;
}

export default async function AllResultsPage({ searchParams }: SearchProps) {
  await requireActiveStaff();
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
        services!inner ( code, name, kind )
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

  const { data, count } = await query.returns<ResultRow[]>();
  const rows = data ?? [];

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
          All results
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
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Requested</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3">Released</th>
                  <th className="px-4 py-3 text-right">Visit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {filtered.map((r) => {
                  const pat = r.visits?.patients;
                  const patientLabel = pat
                    ? `${pat.last_name}, ${pat.first_name}`
                    : "—";
                  return (
                    <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
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
                        <span className="font-mono text-[color:var(--color-brand-text-soft)]">
                          {r.services?.code ?? "—"}
                        </span>{" "}
                        {r.services?.name ?? ""}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {new Date(r.requested_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {r.completed_at
                          ? new Date(r.completed_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {r.released_at
                          ? new Date(r.released_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-xs">
                        {r.visits?.id ? (
                          <Link
                            href={`/staff/visits/${r.visits.id}`}
                            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                          >
                            {r.visits.visit_number}
                          </Link>
                        ) : "—"}
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
