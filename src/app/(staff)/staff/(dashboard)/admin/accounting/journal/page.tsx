import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { manilaDate, todayManilaISODate } from "@/lib/dates/manila";
import { fetchAllRows } from "@/lib/reports/paging";
import {
  ariaSortFor,
  buildListHref,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = { title: "Journal Entries" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/staff/admin/accounting/journal";

/** This list has always shown 50 entries; the picker can change it. */
const DEFAULT_SIZE = 50;

/** Ceiling on the journal lines fetched for one page of entries. */
const MAX_LINES_PER_PAGE = 5000;

/**
 * Sortable columns. `parseSort` requires this exact allow-list — the value
 * reaches a PostgREST `.order()`, so it is a security boundary, not just a
 * UI list.
 *
 * "Type (DR)" and "Amount" are absent on purpose: both come from the
 * `journal_lines` query that runs AFTER this window is fetched (the primary
 * debit line can't be read off the `journal_entries` row), so neither can be
 * expressed in this `.order()` — the page renders them with `PlainTh`, the
 * same way the Visits archive handles its test count.
 *
 * `created_at` has no header of its own: it is the order this page has always
 * opened in — when an entry was BOOKED, which for a back-dated entry is not
 * its posting date — so it stays the default and stays reachable by URL.
 */
const SORTABLE_COLUMNS = [
  "created_at",
  "entry_number",
  "posting_date",
  "description",
  "status",
  "source_kind",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "created_at", dir: "desc" };

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

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All sources" },
  { value: "manual", label: "Manual / Quick expense" },
  { value: "payment", label: "Patient payment" },
  { value: "bill_post", label: "AP bill posted" },
  { value: "bill_payment", label: "AP bill payment" },
  { value: "test_request", label: "Lab service" },
  { value: "history_import", label: "History import (12.B)" },
  { value: "reversal", label: "Reversal" },
  { value: "doctor_pf_disbursement", label: "Doctor PF payout" },
];

interface SearchProps {
  searchParams: Promise<{
    status?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
    start?: string;
    end?: string;
    source?: string;
    account?: string;
    q?: string;
  }>;
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

interface LineRow {
  entry_id: string;
  debit_php: number;
  credit_php: number;
  account_id: string;
  chart_of_accounts: { code: string; name: string } | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export default async function JournalListPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const status: StatusFilter = STATUSES.includes(sp.status as StatusFilter)
    ? (sp.status as StatusFilter)
    : "draft";
  const sort = parseSort(sp.sort, sp.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(sp.size, DEFAULT_SIZE);
  const page = parsePage(sp.page);
  const [from, to] = rangeFor(page, size);
  const todayISO = todayManilaISODate();
  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : "";
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : "";
  const source = sp.source?.trim() ?? "";
  const accountCode = sp.account?.trim() ?? "";
  const q = sp.q?.trim() ?? "";

  const admin = createAdminClient();

  // CoA list for the Account filter dropdown.
  const { data: coaList } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code");

  // The account filter used to collect matching `entry_id`s into an `.in()`
  // list. That could not work past a few hundred entries: PostgREST caps ONE
  // response at 1000 rows whatever `.limit()` asks for, so the `.limit(5000)`
  // returned at most 1000 lines and every journal entry past them silently
  // vanished — from the table AND from the count above it. And the `.eq()`
  // was on a LEFT-joined embed, which PostgREST applies to the embed alone,
  // so the parent rows came back unfiltered and had to be re-filtered in JS.
  //
  // An inner-joined embed does the whole job in the query: `journal_lines` is
  // a to-many embed, so PostgREST nests it rather than multiplying entry rows
  // — `count: "exact"` stays an entry count — and the filter on it keeps only
  // entries that actually touch the account. No id list, no ceiling.
  const accountId = accountCode
    ? ((coaList ?? []).find((c) => c.code === accountCode)?.id ?? null)
    : null;
  // A code that matches no active account must return nothing, not everything.
  const accountNoMatch = Boolean(accountCode) && accountId === null;

  let query = admin
    .from("journal_entries")
    .select(
      accountId
        ? "id, entry_number, posting_date, description, status, source_kind, created_at, journal_lines!inner ( account_id )"
        : "id, entry_number, posting_date, description, status, source_kind, created_at",
      { count: "exact" },
    )
    .order(sort.key, { ascending: sort.dir === "asc" })
    // Tie-break on id — entries share a posting date, a status and a source
    // by the hundred, and without a total order `.range()` drops or repeats
    // rows between pages.
    .order("id", { ascending: true })
    .range(from, to);

  if (status !== "all") query = query.eq("status", status);
  if (start) query = query.gte("posting_date", start);
  if (end) query = query.lte("posting_date", end);
  if (source) query = query.eq("source_kind", source as never);
  if (q) query = query.ilike("description", `%${q}%`);
  if (accountId) query = query.eq("journal_lines.account_id", accountId);
  if (accountNoMatch) {
    query = query.eq("id", "00000000-0000-0000-0000-000000000000");
  }

  const { data, count } = await query.returns<JeRow[]>();
  const rows = data ?? [];
  const total = count ?? 0;
  const totalPages = pageCount(total, size);
  const safePage = Math.min(page, totalPages);

  // Pull primary DR line per JE (largest debit, with CoA code/name) for the
  // Type + Amount columns.
  //
  // Walked rather than read in one shot: this asks for the lines of a whole
  // page of entries, and 100 entries of a multi-line payroll or settlement JE
  // clears PostgREST's 1000-row response cap — past which the Type and Amount
  // cells would just read "—", with nothing saying why.
  const primaryByEntry: Map<string, { code: string; name: string; amount: number }> = new Map();
  if (rows.length > 0) {
    const entryIds = rows.map((r) => r.id);
    const { rows: lines } = await fetchAllRows<LineRow>(
      (lineFrom, lineTo) =>
        admin
          .from("journal_lines")
          .select("entry_id, debit_php, credit_php, account_id, chart_of_accounts!account_id ( code, name )")
          .in("entry_id", entryIds)
          // A total order, so the walk cannot drop or repeat a line.
          .order("entry_id", { ascending: true })
          .order("id", { ascending: true })
          .range(lineFrom, lineTo)
          .returns<LineRow[]>(),
      // One page of entries cannot plausibly hold more lines than this; the
      // ceiling exists so a runaway query stops rather than paging forever.
      MAX_LINES_PER_PAGE,
    );

    for (const line of lines) {
      const coa = (Array.isArray(line.chart_of_accounts)
        ? line.chart_of_accounts[0]
        : line.chart_of_accounts) ?? null;
      const debit = Number(line.debit_php);
      if (!coa || debit <= 0) continue;
      const prev = primaryByEntry.get(line.entry_id);
      if (!prev || debit > prev.amount) {
        primaryByEntry.set(line.entry_id, {
          code: coa.code,
          name: coa.name,
          amount: debit,
        });
      }
    }
  }

  // Params at their default are omitted, so the Draft tab on page 1 stays the
  // bare /staff/admin/accounting/journal URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    status: status === "draft" ? null : status,
    start,
    end,
    source,
    account: accountCode,
    q,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_SIZE ? null : String(size),
  };

  function buildHref(overrides: Record<string, string | null>): string {
    return buildListHref(BASE_PATH, baseParams, overrides);
  }

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // A re-sort goes back to page 1 — page 7 of a set that just reordered is
    // a screenful of unrelated entries.
    return buildHref({
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  const expenseAccounts = (coaList ?? []).filter(
    (c) => c.type === "expense" || c.type === "contra_expense",
  );
  const otherAccounts = (coaList ?? []).filter(
    (c) => c.type !== "expense" && c.type !== "contra_expense",
  );

  const hasFilters = Boolean(start || end || source || accountCode || q);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
              Journal Entries
            </h1>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              {total} entr{total === 1 ? "y" : "ies"} ·{" "}
              {STATUS_LABEL[status].toLowerCase()}
              {hasFilters ? " · filtered" : null}
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
              // Switching status keeps the sort, the filters and the page
              // size — same columns, narrower set — but goes back to page 1.
              href={buildHref({ status: s === "draft" ? null : s, page: null })}
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
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 sm:grid-cols-2 lg:grid-cols-6"
        action="/staff/admin/accounting/journal"
      >
        <input type="hidden" name="status" value={status === "draft" ? "" : status} />
        {/* A GET form submits only the fields it carries, so without these
            Apply would silently reset the reader's sort and page size. */}
        {isDefaultSort ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size === DEFAULT_SIZE ? null : (
          <input type="hidden" name="size" value={String(size)} />
        )}
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Date from
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
        <div className="flex flex-col">
          <label
            htmlFor="source"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Source
          </label>
          <select
            id="source"
            name="source"
            defaultValue={source}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="account"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Account
          </label>
          <select
            id="account"
            name="account"
            defaultValue={accountCode}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All accounts</option>
            <optgroup label="Expense">
              {expenseAccounts.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other">
              {otherAccounts.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="flex flex-col sm:col-span-2">
          <label
            htmlFor="q"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Description contains
          </label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. MERALCO, Hi Precision, rent"
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
              // Clears the FILTERS, not the view: sort and page size survive.
              href={buildHref({
                start: null,
                end: null,
                source: null,
                account: null,
                q: null,
                page: null,
              })}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No journal entries match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("entry_number", "Entry #")}
                  {th("posting_date", "Date")}
                  {th("description", "Description")}
                  <PlainTh label="Type (DR)" />
                  <PlainTh label="Amount" align="right" />
                  {th("source_kind", "Source")}
                  {th("status", "Status")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((je) => {
                  const primary = primaryByEntry.get(je.id);
                  return (
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
                      <td className="whitespace-nowrap px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {/* Sorting still keys off the underlying ISO value —
                            this is the label only. */}
                        {manilaDate(je.posting_date)}
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text)]">
                        {je.description}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {primary ? (
                          <span>
                            <span className="font-mono text-[color:var(--color-brand-text-soft)]">{primary.code}</span>
                            <span className="ml-1">{primary.name}</span>
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {primary ? PHP.format(primary.amount) : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {je.source_kind}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[je.status] ?? ""}`}
                        >
                          {je.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ListPagination
        page={safePage}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          safePage > 1
            ? buildHref({ page: safePage - 1 > 1 ? String(safePage - 1) : null })
            : null
        }
        nextHref={safePage < totalPages ? buildHref({ page: String(safePage + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((n) => ({
          size: n,
          // Resizing resets to page 1 — same reasoning as a re-sort.
          href: buildHref({
            size: n === DEFAULT_SIZE ? null : String(n),
            page: null,
          }),
        }))}
        noun="entry"
        plural="entries"
      />
    </div>
  );
}
