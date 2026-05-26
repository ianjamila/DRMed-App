import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Doctor PF YTD summary — staff" };
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
  pf_php: number;
  recognized_at: string | null;
  recognition_basis: string;
  physician_id: string;
  disbursement_id: string | null;
  created_at: string;
  physicians:
    | { id: string; full_name: string; compensation_arrangement: string | null }
    | { id: string; full_name: string; compensation_arrangement: string | null }[]
    | null;
}

interface DisbursementRow {
  id: string;
  physician_id: string;
  posted_date: string;
  total_php: number;
  voided_at: string | null;
}

interface PhysicianSummary {
  id: string;
  name: string;
  arrangement: string | null;
  accruedYtd: number;
  accruedCount: number;
  recognizedCashYtd: number;
  recognizedHmoYtd: number;
  pendingHmoSettlement: number;
  pendingHmoCount: number;
  disbursedYtd: number;
  unrecognizedNonHmo: number;
  openBalance: number;
}

function pluckPhysician(
  v:
    | { id: string; full_name: string; compensation_arrangement: string | null }
    | { id: string; full_name: string; compensation_arrangement: string | null }[]
    | null,
) {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default async function PfYtdSummaryPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const currentYear = Number(todayISO.slice(0, 4));
  const requestedYear = Number(sp.year);
  const year =
    Number.isFinite(requestedYear) && requestedYear >= 2020 && requestedYear <= currentYear + 1
      ? requestedYear
      : currentYear;

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const admin = createAdminClient();

  // Pull all non-voided entries created in this year. We aggregate in JS so
  // we can split by recognition_basis × recognized state without 4 separate
  // RPC calls.
  const [{ data: entries }, { data: disbursements }] = await Promise.all([
    admin
      .from("doctor_pf_entries")
      .select(
        `
        id, pf_php, recognized_at, recognition_basis, physician_id,
        disbursement_id, created_at,
        physicians ( id, full_name, compensation_arrangement )
      `,
      )
      .gte("created_at", `${yearStart}T00:00:00+08:00`)
      .lt("created_at", `${year + 1}-01-01T00:00:00+08:00`)
      .is("voided_at", null)
      .returns<EntryRow[]>(),
    admin
      .from("doctor_pf_disbursements")
      .select("id, physician_id, posted_date, total_php, voided_at")
      .gte("posted_date", yearStart)
      .lte("posted_date", yearEnd)
      .is("voided_at", null)
      .returns<DisbursementRow[]>(),
  ]);

  const byPhysician = new Map<string, PhysicianSummary>();

  for (const e of entries ?? []) {
    const ph = pluckPhysician(e.physicians);
    if (!ph) continue;
    const row = byPhysician.get(ph.id) ?? {
      id: ph.id,
      name: ph.full_name,
      arrangement: ph.compensation_arrangement,
      accruedYtd: 0,
      accruedCount: 0,
      recognizedCashYtd: 0,
      recognizedHmoYtd: 0,
      pendingHmoSettlement: 0,
      pendingHmoCount: 0,
      disbursedYtd: 0,
      unrecognizedNonHmo: 0,
      openBalance: 0,
    };
    const amt = Number(e.pf_php ?? 0);
    row.accruedYtd += amt;
    row.accruedCount += 1;

    if (e.recognized_at) {
      if (e.recognition_basis === "hmo_at_settlement") {
        row.recognizedHmoYtd += amt;
      } else {
        row.recognizedCashYtd += amt;
      }
    } else {
      if (e.recognition_basis === "hmo_at_settlement") {
        row.pendingHmoSettlement += amt;
        row.pendingHmoCount += 1;
      } else {
        row.unrecognizedNonHmo += amt;
      }
    }

    byPhysician.set(ph.id, row);
  }

  for (const d of disbursements ?? []) {
    const row = byPhysician.get(d.physician_id);
    if (!row) continue;
    row.disbursedYtd += Number(d.total_php ?? 0);
  }

  // Open balance = recognized but not yet disbursed (clinic owes the doctor).
  for (const row of byPhysician.values()) {
    row.openBalance =
      row.recognizedCashYtd + row.recognizedHmoYtd - row.disbursedYtd;
  }

  const rows = Array.from(byPhysician.values()).sort(
    (a, b) => b.accruedYtd - a.accruedYtd,
  );

  // Grand totals
  const totals = rows.reduce(
    (acc, r) => ({
      accruedYtd: acc.accruedYtd + r.accruedYtd,
      recognizedYtd: acc.recognizedYtd + r.recognizedCashYtd + r.recognizedHmoYtd,
      disbursedYtd: acc.disbursedYtd + r.disbursedYtd,
      pendingHmoSettlement: acc.pendingHmoSettlement + r.pendingHmoSettlement,
      openBalance: acc.openBalance + r.openBalance,
    }),
    {
      accruedYtd: 0,
      recognizedYtd: 0,
      disbursedYtd: 0,
      pendingHmoSettlement: 0,
      openBalance: 0,
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
              Doctor PF YTD summary
            </h1>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
              Year-to-date professional fee earnings per physician for{" "}
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                {year}
              </span>
              .
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
          label="Accrued YTD"
          value={PHP.format(totals.accruedYtd)}
          hint="Sum of non-voided PF entries"
        />
        <SummaryTile
          label="Recognized YTD"
          value={PHP.format(totals.recognizedYtd)}
          hint="Cash + HMO-settled"
        />
        <SummaryTile
          label="Disbursed YTD"
          value={PHP.format(totals.disbursedYtd)}
          hint="Sum of disbursement totals"
        />
        <SummaryTile
          label="Pending HMO settlement"
          value={PHP.format(totals.pendingHmoSettlement)}
          hint="Awaiting HMO payment allocation"
          tone={totals.pendingHmoSettlement > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Open balance"
          value={PHP.format(totals.openBalance)}
          hint="Recognized − disbursed (clinic owes doctors)"
          tone={totals.openBalance > 0 ? "warn" : "ok"}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No PF activity in {year}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Physician</th>
                  <th className="px-4 py-3 text-right">Accrued YTD</th>
                  <th className="px-4 py-3 text-right">Recognized cash</th>
                  <th className="px-4 py-3 text-right">Recognized HMO</th>
                  <th className="px-4 py-3 text-right">Pending HMO</th>
                  <th className="px-4 py-3 text-right">Disbursed</th>
                  <th className="px-4 py-3 text-right">Open balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-[color:var(--color-brand-navy)]">
                        {r.name}
                      </p>
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {arrangementLabel(r.arrangement)} · {r.accruedCount}{" "}
                        entr{r.accruedCount === 1 ? "y" : "ies"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.accruedYtd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                      {PHP.format(r.recognizedCashYtd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                      {PHP.format(r.recognizedHmoYtd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {r.pendingHmoSettlement > 0 ? (
                        <span className="text-amber-700">
                          {PHP.format(r.pendingHmoSettlement)}
                        </span>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          {PHP.format(0)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.disbursedYtd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {r.openBalance > 0 ? (
                        <span className="font-semibold text-[color:var(--color-brand-navy)]">
                          {PHP.format(r.openBalance)}
                        </span>
                      ) : r.openBalance < 0 ? (
                        <span className="text-red-700">
                          {PHP.format(r.openBalance)}
                        </span>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          {PHP.format(0)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-[color:var(--color-brand-bg)] font-semibold">
                <tr>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Totals
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.accruedYtd)}
                  </td>
                  <td colSpan={2} />
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.pendingHmoSettlement)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.disbursedYtd)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {PHP.format(totals.openBalance)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Numbers reflect non-voided PF entries created in {year} and
        non-voided disbursements posted in {year}. Open balance = recognized
        cash + recognized HMO − disbursed. Negative open balance means a
        physician was disbursed more than was recognized in-period (e.g.
        prior-year carryover).
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

function arrangementLabel(arrangement: string | null): string {
  switch (arrangement) {
    case "pf_split":
      return "PF split";
    case "rent_paying":
      return "Rent-paying";
    case "shareholder":
      return "Shareholder";
    default:
      return arrangement ?? "—";
  }
}
