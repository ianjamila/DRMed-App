import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Send-out vendor performance — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface SearchProps {
  searchParams: Promise<{ year?: string }>;
}

interface EntryRow {
  id: string;
  vendor_id: string | null;
  service_id: string;
  test_request_id: string;
  unit_cost_php: number;
  accrued_at: string;
  trued_up_at: string | null;
  services:
    | { name: string; turnaround_hours: number | null }
    | { name: string; turnaround_hours: number | null }[]
    | null;
  test_requests:
    | { requested_at: string; released_at: string | null; status: string }
    | { requested_at: string; released_at: string | null; status: string }[]
    | null;
}

interface TrueupRow {
  id: string;
  vendor_id: string;
  accrued_total_php: number;
  billed_total_php: number;
  variance_php: number;
  matched_at: string;
}

interface Vendor {
  id: string;
  name: string;
}

interface VendorMetric {
  vendorId: string | "unassigned";
  vendorName: string;
  routedCount: number;
  accruedCostYtd: number;
  releasedCount: number;
  pendingCount: number;
  tatHoursSamples: number[];
  slaBreaches: number;
  truedUpAccrued: number;
  truedUpBilled: number;
  variance: number;
  trueupCount: number;
}

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function formatHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24);
  const rem = Math.round(h - d * 24);
  return `${d}d ${rem}h`;
}

export default async function VendorPerformancePage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const currentYear = Number(todayISO.slice(0, 4));
  const requestedYear = Number(sp.year);
  const year =
    Number.isFinite(requestedYear) && requestedYear >= 2023 && requestedYear <= currentYear + 1
      ? requestedYear
      : currentYear;

  const yearStartIso = `${year}-01-01T00:00:00+08:00`;
  const yearEndIso = `${year + 1}-01-01T00:00:00+08:00`;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const admin = createAdminClient();

  const [{ data: entries }, { data: trueups }, { data: vendorList }] =
    await Promise.all([
      admin
        .from("cogs_send_out_entries")
        .select(
          `
          id, vendor_id, service_id, test_request_id, unit_cost_php,
          accrued_at, trued_up_at,
          services ( name, turnaround_hours ),
          test_requests ( requested_at, released_at, status )
        `,
        )
        .gte("accrued_at", yearStartIso)
        .lt("accrued_at", yearEndIso)
        .is("voided_at", null)
        .returns<EntryRow[]>(),
      admin
        .from("cogs_send_out_trueups")
        .select("id, vendor_id, accrued_total_php, billed_total_php, variance_php, matched_at")
        .gte("matched_at", yearStartIso)
        .lt("matched_at", yearEndIso)
        .is("voided_at", null)
        .returns<TrueupRow[]>(),
      admin.from("vendors").select("id, name").returns<Vendor[]>(),
    ]);

  const vendorName = new Map<string, string>();
  for (const v of vendorList ?? []) vendorName.set(v.id, v.name);

  const metrics = new Map<string, VendorMetric>();

  function ensureMetric(vendorId: string | null): VendorMetric {
    const key = vendorId ?? "unassigned";
    const existing = metrics.get(key);
    if (existing) return existing;
    const m: VendorMetric = {
      vendorId: key,
      vendorName:
        vendorId === null
          ? "(no vendor assigned)"
          : (vendorName.get(vendorId) ?? "(unknown vendor)"),
      routedCount: 0,
      accruedCostYtd: 0,
      releasedCount: 0,
      pendingCount: 0,
      tatHoursSamples: [],
      slaBreaches: 0,
      truedUpAccrued: 0,
      truedUpBilled: 0,
      variance: 0,
      trueupCount: 0,
    };
    metrics.set(key, m);
    return m;
  }

  for (const e of entries ?? []) {
    const m = ensureMetric(e.vendor_id);
    m.routedCount += 1;
    m.accruedCostYtd += Number(e.unit_cost_php ?? 0);

    const tr = pluckOne(e.test_requests);
    const svc = pluckOne(e.services);
    if (tr) {
      if (tr.released_at && tr.requested_at) {
        const tatMs = Date.parse(tr.released_at) - Date.parse(tr.requested_at);
        const tatHours = tatMs / 3_600_000;
        if (tatHours >= 0 && tatHours < 24 * 60) {
          // Cap at 60 days to avoid garbage outliers skewing the median
          m.tatHoursSamples.push(tatHours);
          m.releasedCount += 1;
          const sla = svc?.turnaround_hours ?? null;
          if (sla !== null && tatHours > sla) m.slaBreaches += 1;
        }
      } else if (tr.status !== "released" && tr.status !== "cancelled") {
        m.pendingCount += 1;
      }
    }
  }

  for (const t of trueups ?? []) {
    const m = ensureMetric(t.vendor_id);
    m.truedUpAccrued += Number(t.accrued_total_php ?? 0);
    m.truedUpBilled += Number(t.billed_total_php ?? 0);
    m.variance += Number(t.variance_php ?? 0);
    m.trueupCount += 1;
  }

  const rows = Array.from(metrics.values()).sort(
    (a, b) => b.routedCount - a.routedCount,
  );

  const totals = rows.reduce(
    (acc, r) => ({
      routedCount: acc.routedCount + r.routedCount,
      accruedCostYtd: acc.accruedCostYtd + r.accruedCostYtd,
      pendingCount: acc.pendingCount + r.pendingCount,
      slaBreaches: acc.slaBreaches + r.slaBreaches,
      variance: acc.variance + r.variance,
      trueupCount: acc.trueupCount + r.trueupCount,
    }),
    {
      routedCount: 0,
      accruedCostYtd: 0,
      pendingCount: 0,
      slaBreaches: 0,
      variance: 0,
      trueupCount: 0,
    },
  );

  const years: number[] = [];
  for (let y = currentYear; y >= 2023; y--) years.push(y);

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
              Send-out vendor performance
            </h1>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              Per-vendor TAT, accrued cost, and true-up variance for{" "}
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                {year}
              </span>
              . Window: {yearStart} → {yearEnd}.
            </p>
          </div>
          <form action="" className="flex items-center gap-2">
            <label
              htmlFor="year"
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
            >
              Year
            </label>
            <select
              id="year"
              name="year"
              defaultValue={String(year)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
            >
              Go
            </button>
          </form>
        </div>
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryTile
          label="Tests routed"
          value={String(totals.routedCount)}
          hint={`Across ${rows.length} vendor${rows.length === 1 ? "" : "s"}`}
        />
        <SummaryTile
          label="Accrued cost"
          value={PHP.format(totals.accruedCostYtd)}
          hint="Snapshot unit cost × tests"
        />
        <SummaryTile
          label="Pending result"
          value={String(totals.pendingCount)}
          hint="Awaiting external lab"
          tone={totals.pendingCount > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="SLA breaches"
          value={String(totals.slaBreaches)}
          hint="TAT > service turnaround"
          tone={totals.slaBreaches > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="True-up variance"
          value={PHP.format(totals.variance)}
          hint={`${totals.trueupCount} match event${totals.trueupCount === 1 ? "" : "s"}`}
          tone={Math.abs(totals.variance) > 0 ? "warn" : "ok"}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No send-out activity in {year}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1024px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3 text-right">Routed</th>
                  <th className="px-4 py-3 text-right">Released</th>
                  <th className="px-4 py-3 text-right">Pending</th>
                  <th className="px-4 py-3 text-right">Median TAT</th>
                  <th className="px-4 py-3 text-right">P95 TAT</th>
                  <th className="px-4 py-3 text-right">SLA breach</th>
                  <th className="px-4 py-3 text-right">Accrued cost</th>
                  <th className="px-4 py-3 text-right">True-up variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const med = median(r.tatHoursSamples);
                  const p95 = percentile(r.tatHoursSamples, 0.95);
                  const breachPct =
                    r.releasedCount > 0
                      ? Math.round((r.slaBreaches / r.releasedCount) * 100)
                      : 0;
                  return (
                    <tr
                      key={r.vendorId}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td className="px-4 py-3 font-medium text-[color:var(--color-brand-navy)]">
                        {r.vendorName}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.routedCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {r.releasedCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.pendingCount > 0 ? (
                          <span className="text-amber-700">{r.pendingCount}</span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {formatHours(med)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {formatHours(p95)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.slaBreaches > 0 ? (
                          <span className="text-amber-700">
                            {r.slaBreaches} ({breachPct}%)
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {PHP.format(r.accruedCostYtd)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {Math.abs(r.variance) < 0.01 ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : r.variance > 0 ? (
                          <span className="text-red-700">
                            +{PHP.format(r.variance)}
                          </span>
                        ) : (
                          <span className="text-emerald-700">
                            {PHP.format(r.variance)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-[color:var(--color-brand-bg)] font-semibold">
                <tr>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Totals
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {totals.routedCount}
                  </td>
                  <td colSpan={3} />
                  <td className="px-4 py-3 text-right font-mono">
                    {totals.pendingCount}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {totals.slaBreaches}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.accruedCostYtd)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.variance)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        TAT computed from <code>test_requests.released_at − requested_at</code>;
        samples with TAT &gt; 60 days are excluded as garbage outliers. SLA breach uses{" "}
        <code>services.turnaround_hours</code>. True-up variance =
        billed − accrued (positive = vendor billed more than we accrued; negative = vendor billed less).
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
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
      <p className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
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
