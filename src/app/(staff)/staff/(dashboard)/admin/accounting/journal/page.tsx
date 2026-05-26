import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Journal entries — staff" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const STATUSES = ["draft", "posted", "reversed", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_LABEL: Record<StatusFilter, string> = {
  draft: "Draft",
  posted: "Posted",
  reversed: "Reversed",
  all: "All",
};

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  posted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  reversed: "bg-slate-100 text-slate-700 border-slate-200",
};

interface SearchProps {
  searchParams: Promise<{ status?: string; page?: string; start?: string; end?: string }>;
}

interface JeRow {
  id: string;
  entry_number: string;
  posting_date: string;
  description: string;
  status: string;
  source_kind: string;
  created_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function JournalListPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const status: StatusFilter = STATUSES.includes(sp.status as StatusFilter)
    ? (sp.status as StatusFilter)
    : "draft";
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const todayISO = todayManilaISODate();
  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : "";
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : "";

  const admin = createAdminClient();

  let query = admin
    .from("journal_entries")
    .select(
      "id, entry_number, posting_date, description, status, source_kind, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (status !== "all") query = query.eq("status", status);
  if (start) query = query.gte("posting_date", start);
  if (end) query = query.lte("posting_date", end);

  const { data, count } = await query.returns<JeRow[]>();
  const rows = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  function pageHref(p: number) {
    const params = new URLSearchParams();
    if (status !== "draft") params.set("status", status);
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/staff/admin/accounting/journal${qs ? `?${qs}` : ""}`;
  }

  function statusHref(s: StatusFilter) {
    const params = new URLSearchParams();
    if (s !== "draft") params.set("status", s);
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    const qs = params.toString();
    return `/staff/admin/accounting/journal${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
              Journal entries
            </h1>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {total} entr{total === 1 ? "y" : "ies"} ·{" "}
              {STATUS_LABEL[status].toLowerCase()}
              {start || end
                ? ` · ${start || "…"} → ${end || "…"}`
                : null}
            </p>
          </div>
          <Link
            href="/staff/admin/accounting/journal/new"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            + New journal entry
          </Link>
        </div>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => {
          const active = s === status;
          return (
            <Link
              key={s}
              href={statusHref(s)}
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
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
        action="/staff/admin/accounting/journal"
      >
        <input type="hidden" name="status" value={status} />
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Posting date from
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
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
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
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        {start || end ? (
          <Link
            href={statusHref(status)}
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No journal entries match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Entry #</th>
                  <th className="px-4 py-3">Posting date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((je) => (
                  <tr
                    key={je.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        href={`/staff/admin/accounting/journal/${je.id}`}
                        className="text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        {je.entry_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {je.posting_date}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text)]">
                      {je.description}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {je.source_kind}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[je.status] ?? ""}`}
                      >
                        {je.status}
                      </span>
                    </td>
                  </tr>
                ))}
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
                href={pageHref(safePage - 1)}
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
                href={pageHref(safePage + 1)}
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
