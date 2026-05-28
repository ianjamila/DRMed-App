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
  { value: "cogs_send_out", label: "COGS send-out" },
];

interface SearchProps {
  searchParams: Promise<{
    status?: string;
    page?: string;
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
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
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
    .select("code, name, type")
    .eq("is_active", true)
    .order("code");

  // If filtering by account, first find the entry_ids that touch it.
  let entryIdFilter: string[] | null = null;
  if (accountCode) {
    const target = (coaList ?? []).find((c) => c.code === accountCode);
    if (target) {
      const { data: lineHits } = await admin
        .from("journal_lines")
        .select("entry_id, account_id, chart_of_accounts!account_id ( code )")
        .eq("chart_of_accounts.code", accountCode)
        .limit(5000);
      entryIdFilter = Array.from(
        new Set(
          (lineHits ?? [])
            .filter((l) => {
              const coa = l.chart_of_accounts as { code: string } | { code: string }[] | null;
              const code = Array.isArray(coa) ? coa[0]?.code : coa?.code;
              return code === accountCode;
            })
            .map((l) => l.entry_id as string),
        ),
      );
    }
  }

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
  if (source) query = query.eq("source_kind", source as never);
  if (q) query = query.ilike("description", `%${q}%`);
  if (entryIdFilter) {
    if (entryIdFilter.length === 0) {
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("id", entryIdFilter);
    }
  }

  const { data, count } = await query.returns<JeRow[]>();
  const rows = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  // Pull primary DR line per JE (largest debit, with CoA code/name) for the
  // Type + Amount columns.
  let primaryByEntry: Map<string, { code: string; name: string; amount: number }> = new Map();
  if (rows.length > 0) {
    const { data: lines } = await admin
      .from("journal_lines")
      .select("entry_id, debit_php, credit_php, account_id, chart_of_accounts!account_id ( code, name )")
      .in("entry_id", rows.map((r) => r.id))
      .returns<LineRow[]>();

    for (const line of lines ?? []) {
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

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const base: Record<string, string> = {
      status: status === "draft" ? "" : status,
      start,
      end,
      source,
      account: accountCode,
      q,
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `/staff/admin/accounting/journal${qs ? `?${qs}` : ""}`;
  }

  const expenseAccounts = (coaList ?? []).filter(
    (c) => c.type === "expense" || c.type === "contra_expense",
  );
  const otherAccounts = (coaList ?? []).filter(
    (c) => c.type !== "expense" && c.type !== "contra_expense",
  );

  const hasFilters = Boolean(start || end || source || accountCode || q);

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
              href={buildHref({ status: s === "draft" ? "" : s })}
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
              href={buildHref({ start: "", end: "", source: "", account: "", q: "" })}
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
                  <th className="px-4 py-3">Entry #</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Type (DR)</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
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
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {je.posting_date}
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
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[je.status] ?? ""}`}
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
