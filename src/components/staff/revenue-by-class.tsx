import Link from "next/link";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import {
  VISIT_CLASS_LABEL,
  type ClassSummaryRow,
  type VisitClass,
} from "@/lib/visits/classification";
import {
  yearOnYearChange,
  type RevenuePreset,
  type RevenuePresetKey,
} from "@/lib/visits/revenue-presets";

// Classification colours deliberately avoid green/amber/red/blue — those read
// as payment status one column over on Visit Records.
export const CLASS_BADGE: Record<VisitClass, string> = {
  lab: "border-sky-200 bg-sky-50 text-sky-800",
  consult: "border-violet-200 bg-violet-50 text-violet-800",
  procedure: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800",
};

export const CLASS_ACCENT: Record<VisitClass, string> = {
  lab: "text-sky-800",
  consult: "text-violet-800",
  procedure: "text-fuchsia-800",
};

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const PHP_COMPACT = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

/** The same breakdown over the same dates one year earlier. */
export interface PriorYearRevenue {
  rows: ClassSummaryRow[];
  totals: { lines: number; revenuePhp: number };
}

function PriorLine({ current, prior }: { current: number; prior: number }) {
  const change = yearOnYearChange(current, prior);
  return (
    <>
      {PHP_COMPACT.format(prior)} same dates last year
      {change ? (
        <>
          {" · "}
          <span
            className={
              change.startsWith("+")
                ? "font-semibold text-green-700"
                : change.startsWith("−")
                  ? "font-semibold text-red-700"
                  : "font-semibold"
            }
          >
            {change}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * Admin-only "Revenue by classification" dropdown, shared by Visit Records and
 * the admin dashboard. Collapsed by default — the owner wanted the revenue
 * figures off the everyday screens, one click away rather than gone. `open`
 * keeps it expanded across a click on one of its own links (which reloads the
 * page); every other arrival starts it closed.
 */
export function RevenueByClass({
  rows,
  totals,
  rangeLabel,
  open,
  error = false,
  presets,
  activePreset,
  presetHref,
  cardHref,
  selected,
  notes,
  visitsHref,
  prior,
  pnlHref,
}: {
  rows: ClassSummaryRow[];
  totals: { lines: number; revenuePhp: number };
  rangeLabel: string;
  open: boolean;
  error?: boolean;
  presets: readonly RevenuePreset[];
  /** The preset the current range matches, if any — shown as selected. */
  activePreset?: RevenuePresetKey;
  presetHref: (p: RevenuePreset) => string;
  cardHref: (c: VisitClass) => string;
  /** Classes the surrounding list is filtered to — highlights their cards. */
  selected?: ReadonlySet<VisitClass>;
  notes?: React.ReactNode;
  /** Set off Visit Records: a link to that page over the same range. */
  visitsHref?: string;
  /** Null/absent when the range is open-ended — there is no "last year" of "all dates". */
  prior?: PriorYearRevenue | null;
  /** Expenses & P&L (where Gross Profit lives) over the same dates. */
  pnlHref?: string | null;
}) {
  const priorByClass = new Map(prior?.rows.map((r) => [r.class, r.revenuePhp]));
  return (
    <details
      open={open}
      aria-label="Revenue by classification"
      className="group mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 p-4 [&::-webkit-details-marker]:hidden">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block transition-transform group-open:rotate-90"
          >
            ▸
          </span>
          Revenue by classification · {rangeLabel}
        </h2>
        <span className="text-xs text-[color:var(--color-brand-text-soft)] group-open:hidden">
          Show
        </span>
        {error ? null : (
          <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] group-open:block">
            {totals.lines} billed line{totals.lines === 1 ? "" : "s"} ·{" "}
            <span className="font-mono font-semibold text-[color:var(--color-brand-navy)]">
              {PHP.format(totals.revenuePhp)}
            </span>
            {prior ? (
              <>
                {" · "}
                <PriorLine current={totals.revenuePhp} prior={prior.totals.revenuePhp} />
              </>
            ) : null}
          </p>
        )}
      </summary>
      <div className="px-4 pb-4">
        <nav aria-label="Revenue date range" className="mb-3 flex flex-wrap gap-2 text-xs">
          {presets.map((p) => (
            <Link
              key={p.key}
              href={presetHref(p)}
              aria-current={p.key === activePreset ? "true" : undefined}
              className={`rounded-full border px-3 py-1 font-semibold transition-colors ${
                p.key === activePreset
                  ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        {notes}
        {error ? (
          <p role="status" className="text-sm text-red-700">
            Couldn&apos;t load the revenue figures. Refresh the page to try again.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {rows.map((r) => {
              const share =
                totals.revenuePhp > 0 ? (r.revenuePhp / totals.revenuePhp) * 100 : 0;
              const isSelected = selected?.has(r.class) ?? false;
              return (
                <Link
                  key={r.class}
                  href={cardHref(r.class)}
                  aria-pressed={selected ? isSelected : undefined}
                  className={`rounded-lg border p-3 transition-colors hover:border-[color:var(--color-brand-cyan)] ${
                    isSelected
                      ? CLASS_BADGE[r.class]
                      : "border-[color:var(--color-brand-bg-mid)] bg-white"
                  }`}
                >
                  <p
                    className={`text-xs font-bold uppercase tracking-wider ${CLASS_ACCENT[r.class]}`}
                  >
                    {VISIT_CLASS_LABEL[r.class]}
                  </p>
                  <p className="mt-1 font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
                    {PHP_COMPACT.format(r.revenuePhp)}
                  </p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.visits} visit{r.visits === 1 ? "" : "s"} · {r.lines} line
                    {r.lines === 1 ? "" : "s"} · {share.toFixed(0)}%
                  </p>
                  {prior ? (
                    <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
                      <PriorLine current={r.revenuePhp} prior={priorByClass.get(r.class) ?? 0} />
                    </p>
                  ) : null}
                  {/* Proportion bar — the same number as the percentage, so it
                      is decorative and hidden from assistive tech. */}
                  <span
                    aria-hidden="true"
                    className="mt-2 block h-1 rounded-full bg-[color:var(--color-brand-bg-mid)]"
                  >
                    <span
                      className="block h-1 rounded-full bg-[color:var(--color-brand-cyan)]"
                      style={{ width: `${Math.min(100, share)}%` }}
                    />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Counts billed lines only — items inside a package are covered by the
          package price. A visit with both lab and doctor work is counted under
          both classifications, so the visit counts overlap.
        </p>
        {visitsHref || pnlHref ? (
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
            {visitsHref ? (
              <Link
                href={visitsHref}
                className="text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Open in {ROUTE_NAME["/staff/visits"]} →
              </Link>
            ) : null}
            {pnlHref ? (
              <Link href={pnlHref} className="text-[color:var(--color-brand-cyan)] hover:underline">
                {ROUTE_NAME["/staff/admin/operations/expenses"]} for these dates →
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
    </details>
  );
}
