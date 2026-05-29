import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { paginatedFetch } from "@/lib/supabase/paginated-fetch";
import { todayManilaISODate } from "@/lib/dates/manila";
import { StatementTabs } from "../_components/statement-tabs";
import { PeriodPresets } from "../_components/period-presets";

export const metadata = { title: "Cash flow — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

// Tint negative amounts red (positives keep the default colour passed in).
const negRed = (n: number) => (n < 0 ? "text-red-600" : "");

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Code-prefix is the convention used in this COA: 1010 / 1020 / 1021 / 1030
// are the cash and cash-equivalent accounts. The dashboard already relies on
// this convention via the cash-drawer page. Pulling the list here from the
// COA so a future "1040 Cash in Bank — UnionBank" picks itself up.

interface CashAccount {
  id: string;
  code: string;
  name: string;
}

interface LineRow {
  debit_php: number;
  credit_php: number;
  journal_entries:
    | { posting_date: string; status: string; source_kind: string; description: string | null }
    | null;
  chart_of_accounts: { id: string; code: string; name: string } | null;
}

interface MovementBucket {
  label: string;
  inflow: number;
  outflow: number;
  count: number;
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  payment: "Patient + HMO payments",
  bill_payment: "AP bill payments",
  payroll_run: "Payroll disbursements",
  doctor_payout: "Doctor PF disbursements",
  payroll_13th_month_payout: "13th-month payouts",
  cash_adjustment: "Cash drawer adjustments",
  eod_close: "End-of-day variance",
  manual: "Manual journal entries",
  expense: "Expense entries",
  test_request: "Test request adjustments",
  hmo_claim: "HMO claim activity",
  hmo_claim_resolution: "HMO claim resolutions",
  opening_balance: "Opening balances",
  reversal: "JE reversals",
  bill_post: "Bill posting (non-cash)",
  doctor_pf_accrual: "Doctor PF accrual (non-cash)",
  doctor_pf_disbursement: "Doctor PF disbursements",
  cogs_send_out_accrual: "Send-out COGS accrual (non-cash)",
  cogs_send_out_trueup: "Send-out true-up",
};

export default async function CashFlowPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const yearStart = `${todayISO.slice(0, 4)}-01-01`;
  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : yearStart;
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : todayISO;

  const admin = createAdminClient();

  // ---- Fetch cash account list -------------------------------------------
  const { data: cashAccountsRaw } = await admin
    .from("chart_of_accounts")
    .select("id, code, name")
    .eq("type", "asset")
    .in("code", ["1010", "1020", "1021", "1030"])
    .returns<CashAccount[]>();
  const cashAccounts = cashAccountsRaw ?? [];
  const cashAccountIds = cashAccounts.map((a) => a.id);

  if (cashAccountIds.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold text-[color:var(--color-brand-navy)]">
          Cash flow
        </h1>
        <p className="mt-4 text-sm text-[color:var(--color-brand-text-soft)]">
          No cash accounts found in the chart of accounts. Expected codes
          1010, 1020, 1021, 1030 — seed them via /staff/admin/accounting/chart-of-accounts.
        </p>
      </div>
    );
  }

  // ---- Beginning balance (cumulative through start-1) --------------------
  const dayBefore = new Date(`${start}T00:00:00+08:00`);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const beginningDate = dayBefore.toISOString().slice(0, 10);

  const beginningLines = await paginatedFetch<LineRow>((from, to) =>
    admin
      .from("journal_lines")
      .select(
        `
        debit_php, credit_php,
        journal_entries!inner ( posting_date, status, source_kind, description ),
        chart_of_accounts!inner ( id, code, name )
      `,
      )
      .eq("journal_entries.status", "posted")
      .lte("journal_entries.posting_date", beginningDate)
      .in("account_id", cashAccountIds)
      .range(from, to)
      .returns<LineRow[]>(),
  );

  const beginningByAccount = new Map<string, number>();
  for (const row of beginningLines) {
    const acct = row.chart_of_accounts;
    if (!acct) continue;
    const delta = Number(row.debit_php ?? 0) - Number(row.credit_php ?? 0);
    beginningByAccount.set(acct.id, (beginningByAccount.get(acct.id) ?? 0) + delta);
  }
  const beginningTotal = Array.from(beginningByAccount.values()).reduce(
    (s, v) => s + v,
    0,
  );

  // ---- Period movements (debits = inflow, credits = outflow) -------------
  const periodLines = await paginatedFetch<LineRow>((from, to) =>
    admin
      .from("journal_lines")
      .select(
        `
        debit_php, credit_php,
        journal_entries!inner ( posting_date, status, source_kind, description ),
        chart_of_accounts!inner ( id, code, name )
      `,
      )
      .eq("journal_entries.status", "posted")
      .gte("journal_entries.posting_date", start)
      .lte("journal_entries.posting_date", end)
      .in("account_id", cashAccountIds)
      .range(from, to)
      .returns<LineRow[]>(),
  );

  // Aggregate by source_kind for the waterfall.
  const buckets = new Map<string, MovementBucket>();
  const closingByAccount = new Map<string, number>(beginningByAccount);

  for (const row of periodLines) {
    const sk = row.journal_entries?.source_kind ?? "manual";
    const acct = row.chart_of_accounts;
    if (!acct) continue;
    const d = Number(row.debit_php ?? 0);
    const c = Number(row.credit_php ?? 0);

    closingByAccount.set(acct.id, (closingByAccount.get(acct.id) ?? 0) + d - c);

    const bucket = buckets.get(sk) ?? {
      label: SOURCE_KIND_LABEL[sk] ?? sk,
      inflow: 0,
      outflow: 0,
      count: 0,
    };
    if (d > 0) bucket.inflow += d;
    if (c > 0) bucket.outflow += c;
    bucket.count += 1;
    buckets.set(sk, bucket);
  }

  const closingTotal = Array.from(closingByAccount.values()).reduce(
    (s, v) => s + v,
    0,
  );

  // Sort buckets by absolute movement so big ones float to the top.
  const orderedBuckets = Array.from(buckets.entries())
    .map(([key, b]) => ({ key, ...b, net: b.inflow - b.outflow }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const totalInflow = orderedBuckets.reduce((s, b) => s + b.inflow, 0);
  const totalOutflow = orderedBuckets.reduce((s, b) => s + b.outflow, 0);
  const netMovement = totalInflow - totalOutflow;
  const closingComputed = beginningTotal + netMovement;
  const drift = closingTotal - closingComputed;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Financial statements
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Cash flow from <strong>{start}</strong> → <strong>{end}</strong>{" "}
          (direct method, against cash accounts {cashAccounts.map((a) => a.code).join(", ")}).
        </p>
      </header>

      <StatementTabs />

      <PeriodPresets
        pathname="/staff/admin/accounting/financial-statements/cash-flow"
        start={start}
        end={end}
        todayISO={todayManilaISODate()}
      />

      <form
        action=""
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Start date
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
            End date
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
          Recalculate
        </button>
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Beginning balance"
          value={PHP.format(beginningTotal)}
          hint={`as of ${beginningDate}`}
          valueNegative={beginningTotal < 0}
        />
        <SummaryTile
          label="Period inflows"
          value={PHP.format(totalInflow)}
          hint={`${orderedBuckets.length} source kind${orderedBuckets.length === 1 ? "" : "s"}`}
          tone="ok"
        />
        <SummaryTile
          label="Period outflows"
          value={PHP.format(totalOutflow)}
          hint=" "
          tone={totalOutflow > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Ending balance"
          value={PHP.format(closingTotal)}
          hint={`Δ ${PHP.format(netMovement)}`}
          tone={netMovement < 0 ? "warn" : "ok"}
          valueNegative={closingTotal < 0}
          hintNegative={netMovement < 0}
        />
      </div>

      {Math.abs(drift) > 0.01 ? (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Reconciliation drift:</strong> the sum of period movements
          ({PHP.format(netMovement)}) doesn&apos;t match the difference of
          beginning vs. ending balances ({PHP.format(closingTotal - beginningTotal)}).
          Drift: {PHP.format(drift)}. This usually means a JE was posted with
          a non-standard <code>source_kind</code>.
        </div>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Source kind</th>
              <th className="px-4 py-3 text-right">Inflow</th>
              <th className="px-4 py-3 text-right">Outflow</th>
              <th className="px-4 py-3 text-right">Net</th>
              <th className="px-4 py-3 text-right">Entries</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            <tr className="bg-[color:var(--color-brand-bg)]/40 font-semibold">
              <td className="px-4 py-3">Beginning cash balance</td>
              <td colSpan={2} />
              <td className={`px-4 py-3 text-right font-mono ${negRed(beginningTotal)}`}>
                {PHP.format(beginningTotal)}
              </td>
              <td />
            </tr>
            {orderedBuckets.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No cash movements in this range.
                </td>
              </tr>
            ) : (
              orderedBuckets.map((b) => (
                <tr key={b.key} className="hover:bg-[color:var(--color-brand-bg)]/50">
                  <td className="px-4 py-2 text-[color:var(--color-brand-text)]">
                    {b.label}{" "}
                    <span className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                      {b.key}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {b.inflow > 0 ? (
                      <span className="text-emerald-700">
                        {PHP.format(b.inflow)}
                      </span>
                    ) : (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {b.outflow > 0 ? (
                      <span className="text-red-700">
                        −{PHP.format(b.outflow)}
                      </span>
                    ) : (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        —
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${negRed(b.net)}`}>
                    {PHP.format(b.net)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                    {b.count}
                  </td>
                </tr>
              ))
            )}
            <tr className="font-semibold">
              <td className="px-4 py-3 text-[color:var(--color-brand-navy)]">
                Net cash movement
              </td>
              <td className="px-4 py-3 text-right font-mono text-emerald-700">
                {PHP.format(totalInflow)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-red-700">
                −{PHP.format(totalOutflow)}
              </td>
              <td className={`px-4 py-3 text-right font-mono ${negRed(netMovement)}`}>
                {PHP.format(netMovement)}
              </td>
              <td />
            </tr>
            <tr className="border-t-2 border-[color:var(--color-brand-navy)]/30 bg-[color:var(--color-brand-bg)]/60 font-bold">
              <td className="px-4 py-3 text-[color:var(--color-brand-navy)]">
                Ending cash balance
              </td>
              <td colSpan={2} />
              <td className={`px-4 py-3 text-right font-mono ${closingTotal < 0 ? "text-red-600" : "text-[color:var(--color-brand-navy)]"}`}>
                {PHP.format(closingTotal)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </section>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-[color:var(--color-brand-navy)]">
          How this is computed
        </summary>
        <div className="mt-3 space-y-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <p>
            Cash flow uses the <strong>direct method</strong>: for each posted
            journal line touching a cash account (codes 1010, 1020, 1021,
            1030 by convention), debits are inflows and credits are outflows.
            Lines are grouped by their source journal entry&apos;s{" "}
            <code>source_kind</code> (e.g. <code>payment</code>,{" "}
            <code>bill_payment</code>, <code>payroll_run</code>) so each
            category is one row of the waterfall.
          </p>
          <p>
            Beginning balance is the cumulative net of cash-account JE lines
            with <code>posting_date ≤ start − 1 day</code>. Ending balance is
            the cumulative net through <code>end</code>. The reconciliation
            check on top compares the sum of period movements to the
            difference of beginning vs. ending balance — drift means a JE
            slipped into an unfamiliar source_kind.
          </p>
        </div>
      </details>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
  valueNegative = false,
  hintNegative = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
  // Tint the main figure / the hint red when the underlying amount is negative.
  valueNegative?: boolean;
  hintNegative?: boolean;
}) {
  const accent =
    tone === "warn"
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-2 whitespace-nowrap font-[family-name:var(--font-heading)] text-2xl font-extrabold ${
          valueNegative ? "text-red-600" : "text-[color:var(--color-brand-navy)]"
        }`}
      >
        {value}
      </p>
      {hint ? (
        <p
          className={`mt-1 whitespace-nowrap text-xs ${
            hintNegative
              ? "font-semibold text-red-600"
              : "text-[color:var(--color-brand-text-soft)]"
          }`}
        >
          {hint}
        </p>
      ) : null}
    </article>
  );
}
