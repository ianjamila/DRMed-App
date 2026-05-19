"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import { formatPhp } from "@/lib/marketing/format";
import { formatManilaDate } from "@/lib/payroll/format";
import {
  createContributionBracketAction,
  createWtBracketAction,
  endContributionBracketAction,
  endWtBracketAction,
} from "../config/actions";

// =============================================================================
// Prop shapes
// =============================================================================

export type RateKind = "sss" | "philhealth" | "pagibig" | "wt";

export interface ContributionBracketRow {
  id: string;
  kind: string;
  effective_from: string;
  effective_to: string | null;
  monthly_salary_credit_min_php: number;
  monthly_salary_credit_max_php: number;
  employee_share_php: number;
  employer_share_php: number;
  notes: string | null;
}

export interface WtBracketRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
  taxable_min_php: number;
  taxable_max_php: number | null;
  base_tax_php: number;
  marginal_rate: number; // 0..1 (e.g. 0.20 = 20%)
  notes: string | null;
}

interface Props {
  kind: RateKind;
  contributionBrackets: ContributionBracketRow[];
  wtBrackets: WtBracketRow[];
  activeCounts: Record<RateKind, number>;
  todayManila: string;
  error: string | null;
}

const ROUTE = "/staff/admin/payroll/rates";

const TAB_LABEL: Record<RateKind, string> = {
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
  wt: "Withholding tax",
};

// =============================================================================
// Main client
// =============================================================================

export function RatesClient({
  kind,
  contributionBrackets,
  wtBrackets,
  activeCounts,
  todayManila,
  error,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const switchKind = useCallback(
    (nextKind: RateKind) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.set("kind", nextKind);
      const qs = next.toString();
      setActionError(null);
      startTransition(() => {
        router.replace(qs ? `${ROUTE}?${qs}` : ROUTE);
      });
    },
    [router, searchParams],
  );

  const handleEndContribution = useCallback(
    (row: ContributionBracketRow) => {
      const today = todayManila;
      const ok = window.confirm(
        `End this ${TAB_LABEL[row.kind as RateKind] ?? row.kind} bracket as of ${today}? It will no longer apply to payroll runs on or after that date.`,
      );
      if (!ok) return;
      startTransition(async () => {
        const result = await endContributionBracketAction(row.id, today);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        router.refresh();
      });
    },
    [router, todayManila],
  );

  const handleEndWt = useCallback(
    (row: WtBracketRow) => {
      const today = todayManila;
      const ok = window.confirm(
        `End this WT bracket as of ${today}? It will no longer apply to payroll runs on or after that date.`,
      );
      if (!ok) return;
      startTransition(async () => {
        const result = await endWtBracketAction(row.id, today);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        router.refresh();
      });
    },
    [router, todayManila],
  );

  const tabKinds: RateKind[] = ["sss", "philhealth", "pagibig", "wt"];

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {actionError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
      ) : null}

      {/* Tab strip */}
      <div
        role="tablist"
        aria-label="Rate categories"
        className="flex flex-wrap gap-2 border-b border-[color:var(--color-brand-bg-mid)] pb-2"
      >
        {tabKinds.map((k) => {
          const active = k === kind;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchKind(k)}
              disabled={isPending}
              className={`min-h-[44px] rounded-md px-4 py-2 text-sm font-bold transition disabled:opacity-50 ${
                active
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {TAB_LABEL[k]}
              <span
                className={`ml-2 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                  active
                    ? "bg-white/20 text-white"
                    : "bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]"
                }`}
              >
                {activeCounts[k]} active
              </span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          + Add {kind === "wt" ? "WT" : TAB_LABEL[kind]} bracket
        </button>
      </div>

      {/* Body */}
      {kind === "wt" ? (
        <WtTable
          rows={wtBrackets}
          isPending={isPending}
          onEnd={handleEndWt}
        />
      ) : (
        <ContributionTable
          rows={contributionBrackets}
          isPending={isPending}
          onEnd={handleEndContribution}
        />
      )}

      {/* Add drawer */}
      <AddBracketDrawer
        open={drawerOpen}
        kind={kind}
        defaultEffectiveFrom={todayManila}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => {
          setDrawerOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

// =============================================================================
// Status pill
// =============================================================================

function ActivePill({ effectiveTo }: { effectiveTo: string | null }) {
  if (effectiveTo === null) {
    return (
      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
        Active
      </span>
    );
  }
  return (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
      Ended {effectiveTo}
    </span>
  );
}

// =============================================================================
// Contribution table (SSS / PhilHealth / Pag-IBIG)
// =============================================================================

function ContributionTable({
  rows,
  isPending,
  onEnd,
}: {
  rows: ContributionBracketRow[];
  isPending: boolean;
  onEnd: (row: ContributionBracketRow) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Effective from</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">MSC lower</th>
              <th className="px-4 py-3 text-right">MSC upper</th>
              <th className="px-4 py-3 text-right">EE share</th>
              <th className="px-4 py-3 text-right">ER share</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No brackets recorded.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const active = r.effective_to === null;
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 align-middle">
                      <div className="font-semibold text-[color:var(--color-brand-navy)]">
                        {formatManilaDate(r.effective_from)}
                      </div>
                      <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {r.effective_from}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <ActivePill effectiveTo={r.effective_to} />
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.monthly_salary_credit_min_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.monthly_salary_credit_max_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.employee_share_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.employer_share_php)}
                    </td>
                    <td className="px-4 py-3 align-middle text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.notes ?? "-"}
                    </td>
                    <td className="px-4 py-3 align-middle text-right">
                      {active ? (
                        <button
                          type="button"
                          onClick={() => onEnd(r)}
                          disabled={isPending}
                          className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                        >
                          End bracket
                        </button>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          -
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No brackets recorded.
          </p>
        ) : (
          rows.map((r) => {
            const active = r.effective_to === null;
            return (
              <div
                key={r.id}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      From {formatManilaDate(r.effective_from)}
                    </div>
                    <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.effective_from}
                    </div>
                  </div>
                  <ActivePill effectiveTo={r.effective_to} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      MSC lower
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.monthly_salary_credit_min_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      MSC upper
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.monthly_salary_credit_max_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      EE share
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.employee_share_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      ER share
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.employer_share_php)}
                    </dd>
                  </div>
                </dl>
                {r.notes ? (
                  <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.notes}
                  </p>
                ) : null}
                <div className="mt-3 flex justify-end">
                  {active ? (
                    <button
                      type="button"
                      onClick={() => onEnd(r)}
                      disabled={isPending}
                      className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                    >
                      End bracket
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// =============================================================================
// WT table
// =============================================================================

function formatRatePct(rate: number): string {
  // rate is a fraction in [0, 1]. Show one decimal place so e.g. 0.205 renders
  // as "20.5%". Two decimals would be overkill for tax brackets in practice.
  return `${(rate * 100).toFixed(1)}%`;
}

function WtTable({
  rows,
  isPending,
  onEnd,
}: {
  rows: WtBracketRow[];
  isPending: boolean;
  onEnd: (row: WtBracketRow) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[1080px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Effective from</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Taxable lower</th>
              <th className="px-4 py-3 text-right">Taxable upper</th>
              <th className="px-4 py-3 text-right">Base tax</th>
              <th className="px-4 py-3 text-right">Marginal rate</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No brackets recorded.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const active = r.effective_to === null;
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 align-middle">
                      <div className="font-semibold text-[color:var(--color-brand-navy)]">
                        {formatManilaDate(r.effective_from)}
                      </div>
                      <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {r.effective_from}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <ActivePill effectiveTo={r.effective_to} />
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.taxable_min_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {r.taxable_max_php === null
                        ? "+"
                        : formatPhp(r.taxable_max_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.base_tax_php)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatRatePct(r.marginal_rate)}
                    </td>
                    <td className="px-4 py-3 align-middle text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.notes ?? "-"}
                    </td>
                    <td className="px-4 py-3 align-middle text-right">
                      {active ? (
                        <button
                          type="button"
                          onClick={() => onEnd(r)}
                          disabled={isPending}
                          className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                        >
                          End bracket
                        </button>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          -
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No brackets recorded.
          </p>
        ) : (
          rows.map((r) => {
            const active = r.effective_to === null;
            return (
              <div
                key={r.id}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      From {formatManilaDate(r.effective_from)}
                    </div>
                    <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.effective_from}
                    </div>
                  </div>
                  <ActivePill effectiveTo={r.effective_to} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      Taxable lower
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.taxable_min_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      Taxable upper
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {r.taxable_max_php === null
                        ? "+"
                        : formatPhp(r.taxable_max_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      Base tax
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.base_tax_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      Marginal rate
                    </dt>
                    <dd className="font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                      {formatRatePct(r.marginal_rate)}
                    </dd>
                  </div>
                </dl>
                {r.notes ? (
                  <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.notes}
                  </p>
                ) : null}
                <div className="mt-3 flex justify-end">
                  {active ? (
                    <button
                      type="button"
                      onClick={() => onEnd(r)}
                      disabled={isPending}
                      className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                    >
                      End bracket
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// =============================================================================
// Add bracket drawer
// =============================================================================

interface DrawerProps {
  open: boolean;
  kind: RateKind;
  defaultEffectiveFrom: string;
  onClose: () => void;
  onCreated: () => void;
}

function AddBracketDrawer({
  open,
  kind,
  defaultEffectiveFrom,
  onClose,
  onCreated,
}: DrawerProps) {
  // Shared fields across all four bracket kinds.
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom);
  // "No upper bound" is the open-ended top tier — represented as NULL in the
  // DB. The user toggles this independently of the numeric input below.
  const [noUpperBound, setNoUpperBound] = useState(false);
  const [lowerBound, setLowerBound] = useState("");
  const [upperBound, setUpperBound] = useState("");
  const [notes, setNotes] = useState("");

  // Contribution-only.
  const [eeShare, setEeShare] = useState("");
  const [erShare, setErShare] = useState("");

  // WT-only.
  const [baseTax, setBaseTax] = useState("");
  // Captured as a percentage (e.g. "20" for 20%) and converted to a fraction
  // before submission — easier to read/enter than 0.20.
  const [marginalRatePct, setMarginalRatePct] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Reset every field when the drawer opens or the active kind changes — the
  // user might open it on the SSS tab, close, switch to WT, reopen, and we
  // don't want stale contribution inputs hanging around.
  useEffect(() => {
    if (open) {
      setEffectiveFrom(defaultEffectiveFrom);
      setNoUpperBound(false);
      setLowerBound("");
      setUpperBound("");
      setNotes("");
      setEeShare("");
      setErShare("");
      setBaseTax("");
      setMarginalRatePct("");
      setError(null);
    }
  }, [open, defaultEffectiveFrom, kind]);

  if (!open) return null;

  const submit = () => {
    setError(null);

    if (!effectiveFrom) {
      setError("Effective from is required.");
      return;
    }

    const lowerN = Number(lowerBound);
    if (!Number.isFinite(lowerN) || lowerN < 0) {
      setError("Lower bound must be a non-negative number.");
      return;
    }

    let upperN: number | null = null;
    if (!noUpperBound) {
      const parsed = Number(upperBound);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("Upper bound must be a positive number.");
        return;
      }
      if (parsed <= lowerN) {
        setError("Upper bound must be greater than lower bound.");
        return;
      }
      upperN = parsed;
    }

    if (kind === "wt") {
      const baseN = Number(baseTax);
      if (!Number.isFinite(baseN) || baseN < 0) {
        setError("Base tax must be a non-negative number.");
        return;
      }
      const ratePct = Number(marginalRatePct);
      if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
        setError("Marginal rate must be a percentage between 0 and 100.");
        return;
      }
      const marginalRate = ratePct / 100;
      startTransition(async () => {
        const result = await createWtBracketAction({
          effective_from: effectiveFrom,
          effective_to: null,
          taxable_min_php: lowerN,
          // WT explicitly supports a null upper bound; contribution brackets
          // don't, so we only thread the null through here.
          taxable_max_php: upperN,
          base_tax_php: baseN,
          marginal_rate: marginalRate,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onCreated();
      });
      return;
    }

    // Contribution bracket (sss/philhealth/pagibig). The Zod schema rejects a
    // null upper bound here (monthly_salary_credit_max_php is required) so we
    // surface a friendlier inline error if the admin checked "no upper bound".
    if (upperN === null) {
      setError(
        `Contribution brackets (${TAB_LABEL[kind]}) require an upper bound.`,
      );
      return;
    }

    const eeN = Number(eeShare);
    if (!Number.isFinite(eeN) || eeN < 0) {
      setError("EE share must be a non-negative number.");
      return;
    }
    const erN = Number(erShare);
    if (!Number.isFinite(erN) || erN < 0) {
      setError("ER share must be a non-negative number.");
      return;
    }

    startTransition(async () => {
      const result = await createContributionBracketAction({
        kind,
        effective_from: effectiveFrom,
        effective_to: null,
        monthly_salary_credit_min_php: lowerN,
        monthly_salary_credit_max_php: upperN,
        employee_share_php: eeN,
        employer_share_php: erN,
        notes: notes.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

  const isWt = kind === "wt";
  const title = `Add ${isWt ? "WT" : TAB_LABEL[kind]} bracket`;

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-bracket-title"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <h2
            id="add-bracket-title"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] rounded-md text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Close
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <Field label="Effective from">
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
              The bracket applies to payroll runs from this date forward.
            </p>
          </Field>

          <Field label={isWt ? "Taxable lower bound (PHP)" : "MSC lower bound (PHP)"}>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={lowerBound}
              onChange={(e) => setLowerBound(e.target.value)}
              placeholder="e.g. 4250.00"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          {isWt ? (
            <label className="flex items-center gap-2 text-sm text-[color:var(--color-brand-navy)]">
              <input
                type="checkbox"
                checked={noUpperBound}
                onChange={(e) => setNoUpperBound(e.target.checked)}
                className="h-5 w-5 rounded border-[color:var(--color-brand-bg-mid)]"
              />
              No upper bound (top tier)
            </label>
          ) : null}

          {!noUpperBound ? (
            <Field
              label={isWt ? "Taxable upper bound (PHP)" : "MSC upper bound (PHP)"}
            >
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={upperBound}
                onChange={(e) => setUpperBound(e.target.value)}
                placeholder="e.g. 4749.99"
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
          ) : null}

          {isWt ? (
            <>
              <Field label="Base tax (PHP)">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={baseTax}
                  onChange={(e) => setBaseTax(e.target.value)}
                  placeholder="e.g. 0.00"
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
                <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  Lump-sum tax owed at the start of this bracket.
                </p>
              </Field>
              <Field label="Marginal rate (%)">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max="100"
                  value={marginalRatePct}
                  onChange={(e) => setMarginalRatePct(e.target.value)}
                  placeholder="e.g. 15"
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
                <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  Rate applied to taxable income above the lower bound.
                </p>
              </Field>
            </>
          ) : (
            <>
              <Field label="Employee share (PHP)">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={eeShare}
                  onChange={(e) => setEeShare(e.target.value)}
                  placeholder="e.g. 180.00"
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </Field>
              <Field label="Employer share (PHP)">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={erShare}
                  onChange={(e) => setErShare(e.target.value)}
                  placeholder="e.g. 405.00"
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </Field>
              <Field label="Notes (optional)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. Per SSS Circular 2025-007"
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </Field>
            </>
          )}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="mt-auto flex gap-3 border-t border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {isPending ? "Saving..." : "Add bracket"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
    </label>
  );
}
