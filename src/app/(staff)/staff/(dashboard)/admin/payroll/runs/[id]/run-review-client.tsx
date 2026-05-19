"use client";

import Link from "next/link";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { formatPhp } from "@/lib/marketing/format";
import { formatPeriodRange, formatManilaDate } from "@/lib/payroll/format";
import { PAYMENT_LABEL } from "@/lib/payroll/labels";
import { EarningDeductionDrawer } from "./_components/earning-deduction-drawer";
import { ConfirmDialog } from "./_components/confirm-dialog";
import {
  recomputePayrollRunAction,
  finaliseRunAction,
  voidRunAction,
  reopenVoidedRunAction,
  markEmployeePaidAction,
  voidEmployeePayoutAction,
} from "../actions";

// =============================================================================
// Prop shapes (mirror page.tsx)
// =============================================================================

export interface EarningLineRow {
  id: string;
  kind: string;
  label: string;
  amount_php: number;
  created_by: string | null;
  created_at: string;
}

export interface DeductionLineRow {
  id: string;
  kind: string;
  label: string;
  amount_php: number;
  loan_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface EmployeeRunRow {
  id: string;
  run_id: string;
  employee_id: string;
  full_name: string;
  employee_number: string | null;
  schedule_kind: string;
  payment_method: "cash" | "bank";
  scheduled_days: number;
  days_present: number;
  days_vl_used: number;
  days_sl_used: number;
  days_unpaid_absent: number;
  basic_pay_php: number;
  allowances_total_php: number;
  ot_pay_php: number;
  night_diff_pay_php: number;
  holiday_pay_php: number;
  incentives_total_php: number;
  perfect_attendance_bonus_php: number;
  thirteenth_month_payout_php: number;
  gross_pay_php: number;
  sss_ee_php: number;
  philhealth_ee_php: number;
  pagibig_ee_php: number;
  wt_compensation_php: number;
  tardiness_deduction_php: number;
  staff_advance_settlement_php: number;
  other_deductions_total_php: number;
  net_pay_php: number;
  payout_status: string;
  payment_method_used: string | null;
  paid_at: string | null;
  ot_overage_unpaid_minutes_total: number;
  minutes_late_total: number;
  tardiness_count: number;
  missing_punch_days: number;
  earnings: EarningLineRow[];
  deductions: DeductionLineRow[];
}

export interface RunHeader {
  id: string;
  period_id: string;
  status: string; // draft | computed | finalised | voided
  computed_at: string | null;
  finalised_at: string | null;
  finalised_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  period_start: string;
  period_end: string;
  pay_date: string;
  period_status: string;
  finaliser_name: string | null;
  dtr_imported: boolean;
  sum_gross_php: number;
  sum_net_php: number;
  sum_statutory_and_wt_php: number;
  employee_count: number;
  paid_count: number;
}

interface Props {
  run: RunHeader;
  employeeRuns: EmployeeRunRow[];
  loadError?: string | null;
}

// =============================================================================
// Status pill
// =============================================================================

const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  computed: "Computed",
  finalised: "Finalised",
  voided: "Voided",
};

const RUN_STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-200 text-slate-700",
  computed: "bg-amber-100 text-amber-900",
  finalised: "bg-emerald-100 text-emerald-900",
  voided: "bg-rose-100 text-rose-900",
};

function RunStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        RUN_STATUS_BADGE[status] ?? "bg-slate-200 text-slate-700"
      }`}
    >
      {RUN_STATUS_LABEL[status] ?? status}
    </span>
  );
}

// =============================================================================
// useLocalStorage -- tiny inline hook (no shared util exists yet)
// =============================================================================

type DrawerStyle = "inline" | "slide-out";

const DRAWER_STYLE_KEY = "payroll-run-drawer-style";

// React 19 `useSyncExternalStore` is the canonical way to read from an
// external source (localStorage here) while staying SSR-safe and avoiding a
// setState-in-effect rehydration step.

function subscribeToStorage(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === DRAWER_STYLE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function readStoredDrawerStyle(): DrawerStyle {
  try {
    const raw = window.localStorage.getItem(DRAWER_STYLE_KEY);
    if (raw === "inline" || raw === "slide-out") return raw;
  } catch {
    // Storage may be blocked in private windows.
  }
  return "inline";
}

// During SSR there is no localStorage; the snapshot returns the default.
function getServerDrawerStyle(): DrawerStyle {
  return "inline";
}

function useDrawerStylePreference(): [DrawerStyle, (next: DrawerStyle) => void] {
  const style = useSyncExternalStore(
    subscribeToStorage,
    readStoredDrawerStyle,
    getServerDrawerStyle,
  );

  // Local "echo" counter forces a re-read when the same tab writes — the
  // `storage` event only fires across tabs, so we bump our own subscription
  // by writing then dispatching a synthetic event.
  const update = useCallback((next: DrawerStyle) => {
    try {
      window.localStorage.setItem(DRAWER_STYLE_KEY, next);
      // Fire a same-tab storage event so useSyncExternalStore re-reads.
      window.dispatchEvent(
        new StorageEvent("storage", { key: DRAWER_STYLE_KEY, newValue: next }),
      );
    } catch {
      // Ignore.
    }
  }, []);

  return [style, update];
}

// =============================================================================
// Top-level component
// =============================================================================

type DialogKind = "reimport" | "finalise" | "void-run" | "reopen";

export function RunReviewClient({ run, employeeRuns, loadError }: Props) {
  const router = useRouter();

  const [selectedEmployeeRunId, setSelectedEmployeeRunId] = useState<
    string | null
  >(null);
  const [drawerStylePref, setDrawerStylePref] = useDrawerStylePreference();

  // Header-level action plumbing -- one dialog state at a time.
  const [openDialog, setOpenDialog] = useState<DialogKind | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);
  const [isHeaderPending, startHeaderTransition] = useTransition();
  // Recompute runs on its own transition so it doesn't disable the dialog
  // OPEN buttons (Re-import / Finalise / Void / Reopen) or their Confirm
  // buttons while a recompute is in flight, and vice versa.
  const [isRecomputePending, startRecomputeTransition] = useTransition();

  const closeDialog = () => {
    if (isHeaderPending) return;
    setOpenDialog(null);
    setVoidReason("");
    setDialogError(null);
  };

  const onRecompute = () => {
    setRecomputeError(null);
    startRecomputeTransition(async () => {
      const res = await recomputePayrollRunAction(run.id);
      if (!res.ok) {
        setRecomputeError(res.error);
        return;
      }
      router.refresh();
    });
  };

  const onConfirmReimport = () => {
    // No server call -- this is a destructive-prefaced nav. The actual
    // re-import gating lives on the /dtr screen.
    closeDialog();
    router.push(`/staff/admin/payroll/runs/${run.id}/dtr`);
  };

  const onConfirmFinalise = () => {
    setDialogError(null);
    startHeaderTransition(async () => {
      const res = await finaliseRunAction(run.id);
      if (!res.ok) {
        setDialogError(res.error);
        return;
      }
      setOpenDialog(null);
      router.refresh();
    });
  };

  const onConfirmVoidRun = () => {
    setDialogError(null);
    startHeaderTransition(async () => {
      const res = await voidRunAction({
        run_id: run.id,
        void_reason: voidReason.trim(),
      });
      if (!res.ok) {
        setDialogError(res.error);
        return;
      }
      setOpenDialog(null);
      setVoidReason("");
      router.refresh();
    });
  };

  const onConfirmReopen = () => {
    setDialogError(null);
    startHeaderTransition(async () => {
      const res = await reopenVoidedRunAction({ run_id: run.id });
      if (!res.ok) {
        setDialogError(res.error);
        return;
      }
      setOpenDialog(null);
      router.refresh();
    });
  };

  // Detect mobile viewport to force slide-out style. Tailwind's md breakpoint
  // is 768px; match that here so the toggle's effective state matches the
  // table layout below.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const effectiveDrawerStyle: DrawerStyle = isMobile
    ? "slide-out"
    : drawerStylePref;

  const selected = useMemo(
    () =>
      selectedEmployeeRunId == null
        ? null
        : employeeRuns.find((er) => er.id === selectedEmployeeRunId) ?? null,
    [employeeRuns, selectedEmployeeRunId],
  );

  const otOverageEmployees = useMemo(
    () => employeeRuns.filter((er) => er.ot_overage_unpaid_minutes_total > 0),
    [employeeRuns],
  );

  // Void-run is disabled while ANY employee payout has already been processed
  // -- the void should be done at the payout level first to keep the per-row
  // JE reversals tractable.
  const paidEmployeeCount = useMemo(
    () => employeeRuns.filter((er) => er.payout_status === "paid").length,
    [employeeRuns],
  );
  const voidRunDisabled = paidEmployeeCount > 0;
  const voidRunDisabledReason = voidRunDisabled
    ? `Cannot void -- ${paidEmployeeCount} employee${paidEmployeeCount === 1 ? "" : "s"} already paid. Void individual payouts first.`
    : null;

  // Cash payouts still pending for today's pay date -- surfaces the banner
  // pointing reception at the cash drawer.
  const cashPendingCount = useMemo(
    () =>
      employeeRuns.filter(
        (er) =>
          er.payout_status === "pending" && er.payment_method === "cash",
      ).length,
    [employeeRuns],
  );

  const finaliserLabel = run.finaliser_name ?? "Not finalised yet";
  const showPayoutColumn =
    run.status === "finalised" || run.status === "voided";
  const tableColCount = showPayoutColumn ? 7 : 6;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        <Link
          href="/staff/admin/payroll/runs"
          className="hover:text-[color:var(--color-brand-navy)]"
        >
          {"<-"} Pay runs
        </Link>
      </p>

      {/* Header card */}
      <header className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] sm:text-3xl">
              Pay run · {formatPeriodRange(run.period_start, run.period_end)}
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
              Pay date {formatManilaDate(run.pay_date)} · {finaliserLabel} ·{" "}
              {run.employee_count}{" "}
              {run.employee_count === 1 ? "employee" : "employees"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusPill status={run.status} />
            <RunActionCluster
              status={run.status}
              isPending={isHeaderPending}
              isRecomputePending={isRecomputePending}
              voidRunDisabled={voidRunDisabled}
              voidRunDisabledReason={voidRunDisabledReason}
              onRecompute={onRecompute}
              onReimportClick={() => {
                setDialogError(null);
                setOpenDialog("reimport");
              }}
              onFinaliseClick={() => {
                setDialogError(null);
                setOpenDialog("finalise");
              }}
              onVoidRunClick={() => {
                setDialogError(null);
                setVoidReason("");
                setOpenDialog("void-run");
              }}
              onReopenClick={() => {
                setDialogError(null);
                setOpenDialog("reopen");
              }}
            />
          </div>
        </div>
        {recomputeError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            Recompute failed: {recomputeError}
          </p>
        ) : null}
      </header>

      {/* Load error banner -- surfaces a partial fetch failure for the
          per-employee list. We render the rest of the page (the run header
          read succeeded) but flag that the table is empty due to a DB error
          rather than a truly empty run. */}
      {loadError ? (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3"
        >
          <p className="font-[family-name:var(--font-heading)] text-sm font-extrabold text-rose-900">
            Could not load per-employee rows
          </p>
          <p className="mt-1 text-sm text-rose-900">{loadError}</p>
        </div>
      ) : null}

      {/* KPI strip */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiBox label="Σ Gross" value={formatPhp(run.sum_gross_php)} />
        <KpiBox
          label="Σ Statutory + WT"
          value={formatPhp(run.sum_statutory_and_wt_php)}
        />
        <KpiBox label="Σ Net" value={formatPhp(run.sum_net_php)} emphasis />
        <KpiBox
          label="Paid / Total"
          value={`${run.paid_count} / ${run.employee_count}`}
        />
      </section>

      {/* Banners */}
      <div className="mb-6 space-y-3">
        {otOverageEmployees.length > 0 ? (
          <Banner tone="amber" title="OT overage detected">
            <p className="text-sm text-amber-900">
              {otOverageEmployees.length}{" "}
              {otOverageEmployees.length === 1 ? "employee has" : "employees have"}{" "}
              OT time outside any approved slip — total{" "}
              {otOverageEmployees.reduce(
                (sum, er) => sum + er.ot_overage_unpaid_minutes_total,
                0,
              )}{" "}
              minutes. These are NOT paid until you create OT slips:
            </p>
            <ul className="mt-2 list-inside list-disc text-sm text-amber-900">
              {otOverageEmployees.map((er) => (
                <li key={er.id}>
                  {er.full_name} — {er.ot_overage_unpaid_minutes_total} min
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              <Link
                href="/staff/admin/payroll/ot-slips"
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Create OT slips -{">"}
              </Link>
            </p>
          </Banner>
        ) : null}

        {!run.dtr_imported && run.status === "draft" ? (
          <Banner tone="amber" title="No DTR imported yet">
            <p className="text-sm text-amber-900">
              Upload the DTR for this period to compute attendance, OT, and
              tardiness.
            </p>
            <p className="mt-2 text-sm">
              <Link
                href={`/staff/admin/payroll/runs/${run.id}/dtr`}
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Import DTR -{">"}
              </Link>
            </p>
          </Banner>
        ) : null}

        {run.status === "finalised" && cashPendingCount > 0 ? (
          <Banner
            tone="amber"
            title={`${cashPendingCount} cash payout${cashPendingCount === 1 ? "" : "s"} pending`}
          >
            <p className="text-sm text-amber-900">
              {cashPendingCount === 1 ? "One employee is" : `${cashPendingCount} employees are`}{" "}
              waiting on a cash payout for {formatManilaDate(run.pay_date)}.
              Reception can process them at the cash drawer.
            </p>
            <p className="mt-2 text-sm">
              <Link
                href="/staff/payments/cash-drawer"
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Open cash drawer -{">"}
              </Link>
            </p>
          </Banner>
        ) : null}
      </div>

      {/* Per-employee table */}
      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-brand-bg-mid)] px-4 py-3 sm:px-5">
          <h2 className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]">
            Per-employee summary
          </h2>
          {/* The mobile viewport always uses slide-out (more usable on narrow
              screens), so we hide the toggle there entirely. */}
          {!isMobile ? (
            <DrawerStyleToggle
              value={drawerStylePref}
              onChange={setDrawerStylePref}
            />
          ) : null}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3 text-right">Days</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Pay method</th>
                  {showPayoutColumn ? (
                    <th className="px-4 py-3">Payout</th>
                  ) : null}
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {employeeRuns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={tableColCount}
                      className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                    >
                      No employees on this run.
                    </td>
                  </tr>
                ) : null}
                {employeeRuns.map((er) => {
                  const isSelected = selectedEmployeeRunId === er.id;
                  return (
                    <RunRowDesktop
                      key={er.id}
                      er={er}
                      isSelected={isSelected}
                      drawerStyle={effectiveDrawerStyle}
                      showPayoutCell={showPayoutColumn}
                      tableColCount={tableColCount}
                      onSelect={() =>
                        setSelectedEmployeeRunId((cur) =>
                          cur === er.id ? null : er.id,
                        )
                      }
                      inlineDrawer={
                        isSelected && effectiveDrawerStyle === "inline" ? (
                          <EarningDeductionDrawer
                            variant="inline"
                            employeeRun={er}
                            runStatus={run.status}
                            onClose={() => setSelectedEmployeeRunId(null)}
                          />
                        ) : null
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile stacked cards */}
        <div className="space-y-3 px-3 py-3 md:hidden">
          {employeeRuns.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] px-3 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
              No employees on this run.
            </p>
          ) : null}
          {employeeRuns.map((er) => (
            <div
              key={er.id}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
            >
              <button
                type="button"
                onClick={() => setSelectedEmployeeRunId(er.id)}
                className="block w-full min-h-[44px] text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {er.full_name}
                    </p>
                    {er.employee_number ? (
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        #{er.employee_number}
                      </p>
                    ) : null}
                  </div>
                  <PayMethodPill method={er.payment_method} />
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Days
                    </dt>
                    <dd className="font-semibold text-[color:var(--color-brand-navy)]">
                      {er.days_present}
                      {er.scheduled_days > 0
                        ? ` / ${er.scheduled_days}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Gross
                    </dt>
                    <dd className="font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPhp(er.gross_pay_php)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Net
                    </dt>
                    <dd className="font-bold text-[color:var(--color-brand-navy)]">
                      {formatPhp(er.net_pay_php)}
                    </dd>
                  </div>
                </dl>
              </button>
              {showPayoutColumn ? (
                <div className="mt-3 border-t border-[color:var(--color-brand-bg-mid)] pt-3">
                  <PayoutCell employeeRun={er} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* Slide-out drawer (rendered outside the table when in slide-out mode) */}
      {selected && effectiveDrawerStyle === "slide-out" ? (
        <EarningDeductionDrawer
          variant="slide-out"
          employeeRun={selected}
          runStatus={run.status}
          onClose={() => setSelectedEmployeeRunId(null)}
        />
      ) : null}

      {/* Re-import DTR — destructive nav (no server call). */}
      <ConfirmDialog
        open={openDialog === "reimport"}
        title="Re-import DTR for this period?"
        confirmLabel="Yes, re-import DTR"
        confirmVariant="danger"
        cancelLabel="Cancel"
        isPending={isHeaderPending}
        onCancel={closeDialog}
        onConfirm={onConfirmReimport}
        errorMessage={dialogError}
        body={
          <div className="space-y-3">
            <p>
              This run is currently{" "}
              <strong className="text-amber-800">{run.status}</strong>.
              Re-importing the DTR will:
            </p>
            <ul className="list-inside list-disc space-y-1 text-sm">
              <li>Supersede the existing DTR rows (kept for audit)</li>
              <li>Reset the run status to draft</li>
              <li>
                Clear earning / deduction lines created by the previous compute
                (manual lines preserved)
              </li>
              <li>
                Require you to click Recompute before you can finalise again
              </li>
            </ul>
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <strong>Heads up:</strong> Any manual incentive / bonus /
              manual_adjustment lines you added will be preserved. Only the
              auto-computed numbers will be cleared.
            </p>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Choose the CSV file on the next screen. Cancel here to abort.
            </p>
          </div>
        }
      />

      {/* Finalise pay run. */}
      <ConfirmDialog
        open={openDialog === "finalise"}
        title="Finalise pay run?"
        confirmLabel="Yes, finalise and post JE"
        confirmVariant="success"
        cancelLabel="Cancel -- keep as draft"
        isPending={isHeaderPending}
        onCancel={closeDialog}
        onConfirm={onConfirmFinalise}
        errorMessage={dialogError}
        body={
          <div className="space-y-3">
            <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-bg-mid)] px-3 py-2 text-xs">
              <SummaryRow
                label="Period"
                value={formatPeriodRange(run.period_start, run.period_end)}
              />
              <SummaryRow
                label="Pay date"
                value={formatManilaDate(run.pay_date)}
              />
              <SummaryRow
                label="Employees"
                value={`${run.employee_count} in run`}
              />
              <SummaryRow
                label={"Σ Gross pay"}
                value={formatPhp(run.sum_gross_php)}
              />
              <SummaryRow
                label={"Σ Statutory + WT"}
                value={formatPhp(run.sum_statutory_and_wt_php)}
              />
              <div className="mt-1 flex items-center justify-between border-t border-[color:var(--color-brand-bg-mid)] pt-2">
                <strong>{"Σ Net pay (to disburse)"}</strong>
                <strong className="font-[family-name:var(--font-heading)] text-sm">
                  {formatPhp(run.sum_net_php)}
                </strong>
              </div>
            </div>

            <p>On confirm, the system will:</p>
            <ul className="list-inside list-disc space-y-1 text-sm">
              <li>
                Post a single gross-up journal entry (DR Salaries + Benefits,
                CR statutory payables + Salaries Payable)
              </li>
              <li>
                Generate payslip PDFs for each employee (stored in Supabase
                Storage)
              </li>
              <li>
                Lock the run from further line edits -- corrections after this
                go to the next period as manual_adjustment lines
              </li>
              <li>Make Mark Paid buttons available per employee on pay date</li>
            </ul>

            {run.employee_count >= 5 ? (
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Heads up: payslip PDFs render sequentially (~2s each), so this
                may take up to {Math.ceil(run.employee_count * 2)}s for{" "}
                {run.employee_count} employees. The button stays disabled
                until the run is fully finalised.
              </p>
            ) : null}

            {otOverageEmployees.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p>
                  <strong>OT overage notice:</strong> The following{" "}
                  {otOverageEmployees.length === 1 ? "employee has" : "employees have"}{" "}
                  DTR overage without an approved OT slip. Those hours will NOT
                  be paid.
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {otOverageEmployees.map((er) => (
                    <li key={er.id}>
                      {er.full_name} -- {er.ot_overage_unpaid_minutes_total} min
                    </li>
                  ))}
                </ul>
                <p className="mt-1">
                  <Link
                    href="/staff/admin/payroll/ot-slips"
                    className="font-semibold text-amber-900 underline hover:text-amber-700"
                  >
                    Create OT slip
                  </Link>{" "}
                  if you want to include them -- otherwise proceed.
                </p>
              </div>
            ) : null}
          </div>
        }
      />

      {/* Void run. */}
      <ConfirmDialog
        open={openDialog === "void-run"}
        title="Void this pay run?"
        confirmLabel="Yes, void run"
        confirmVariant="danger"
        cancelLabel="Cancel"
        isPending={isHeaderPending}
        onCancel={closeDialog}
        onConfirm={onConfirmVoidRun}
        reasonRequired
        reasonValue={voidReason}
        onReasonChange={setVoidReason}
        errorMessage={dialogError}
        body={
          <div className="space-y-3">
            <p>
              Voiding this run will reverse the gross-up journal entry. The
              generated payslip PDFs remain in storage but are flagged voided
              for audit.
            </p>
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              This action cannot be undone silently -- a reversal JE is posted
              and the run is locked in voided state. Use Reopen to bring it
              back to draft.
            </p>
          </div>
        }
      />

      {/* Reopen voided run. */}
      <ConfirmDialog
        open={openDialog === "reopen"}
        title="Reopen this voided run?"
        confirmLabel="Yes, reopen"
        confirmVariant="primary"
        cancelLabel="Cancel"
        isPending={isHeaderPending}
        onCancel={closeDialog}
        onConfirm={onConfirmReopen}
        errorMessage={dialogError}
        body={
          <div className="space-y-3">
            <p>
              Reopen this run? The previously voided JE remains reversed in the
              ledger. The run goes back to draft so it can be recomputed and
              finalised again.
            </p>
          </div>
        }
      />
    </div>
  );
}

// =============================================================================
// Run action cluster (header right side)
// =============================================================================

function RunActionCluster({
  status,
  isPending,
  isRecomputePending,
  voidRunDisabled,
  voidRunDisabledReason,
  onRecompute,
  onReimportClick,
  onFinaliseClick,
  onVoidRunClick,
  onReopenClick,
}: {
  status: string;
  isPending: boolean;
  isRecomputePending: boolean;
  voidRunDisabled: boolean;
  voidRunDisabledReason: string | null;
  onRecompute: () => void;
  onReimportClick: () => void;
  onFinaliseClick: () => void;
  onVoidRunClick: () => void;
  onReopenClick: () => void;
}) {
  if (status === "draft") {
    return (
      <button
        type="button"
        onClick={onRecompute}
        disabled={isRecomputePending}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        {isRecomputePending ? "Recomputing..." : "Recompute"}
      </button>
    );
  }

  if (status === "computed") {
    // Recompute is intentionally NOT rendered here: server-side it only
    // accepts status='draft', so a Recompute click from computed always
    // fails. Use Re-import DTR to reset to draft first.
    return (
      <>
        <button
          type="button"
          onClick={onReimportClick}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          Re-import DTR
        </button>
        <button
          type="button"
          onClick={onFinaliseClick}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          Finalise
        </button>
      </>
    );
  }

  if (status === "finalised") {
    return (
      <button
        type="button"
        onClick={onVoidRunClick}
        disabled={isPending || voidRunDisabled}
        title={voidRunDisabledReason ?? undefined}
        aria-disabled={isPending || voidRunDisabled}
        className="min-h-[44px] rounded-md border border-rose-200 bg-white px-4 py-2 text-xs font-bold text-rose-700 hover:border-rose-400 disabled:opacity-50"
      >
        Void run
      </button>
    );
  }

  if (status === "voided") {
    return (
      <button
        type="button"
        onClick={onReopenClick}
        disabled={isPending}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        Reopen run
      </button>
    );
  }

  return null;
}

// =============================================================================
// Summary row used inside the finalise dialog
// =============================================================================

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-[color:var(--color-brand-text-soft)]">{label}</span>
      <strong className="text-[color:var(--color-brand-navy)]">{value}</strong>
    </div>
  );
}

// =============================================================================
// KPI box
// =============================================================================

function KpiBox({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-2 font-[family-name:var(--font-heading)] text-[color:var(--color-brand-navy)] ${
          emphasis ? "text-2xl font-extrabold" : "text-xl font-bold"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// =============================================================================
// Banner
// =============================================================================

function Banner({
  tone,
  title,
  children,
}: {
  tone: "amber";
  title: string;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="font-[family-name:var(--font-heading)] text-sm font-extrabold text-amber-900">
        {title}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// =============================================================================
// Pay-method pill
// =============================================================================

function PayMethodPill({ method }: { method: "cash" | "bank" }) {
  const cls =
    method === "cash"
      ? "bg-amber-100 text-amber-900"
      : "bg-sky-100 text-sky-900";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {PAYMENT_LABEL[method] ?? method}
    </span>
  );
}

// =============================================================================
// Per-row (desktop)
// =============================================================================

function RunRowDesktop({
  er,
  isSelected,
  drawerStyle,
  showPayoutCell,
  tableColCount,
  onSelect,
  inlineDrawer,
}: {
  er: EmployeeRunRow;
  isSelected: boolean;
  drawerStyle: DrawerStyle;
  showPayoutCell: boolean;
  tableColCount: number;
  onSelect: () => void;
  inlineDrawer: React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  const isInlineSelected = isSelected && drawerStyle === "inline";
  // Inline mode: row toggles an inline disclosure below itself, so aria-expanded
  // is the semantically correct state. Slide-out mode: row opens a separate
  // dialog, so use aria-haspopup="dialog" + aria-current to mark selection.
  const inlineAria =
    drawerStyle === "inline"
      ? ({ "aria-expanded": isSelected } as const)
      : ({
          "aria-haspopup": "dialog",
          "aria-current": isSelected ? ("true" as const) : undefined,
        } as const);
  return (
    <>
      <tr
        tabIndex={0}
        role="button"
        {...inlineAria}
        aria-label={`Edit lines for ${er.full_name}`}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={`cursor-pointer transition ${
          isSelected
            ? "bg-[color:var(--color-brand-cyan)]/10"
            : "hover:bg-[color:var(--color-brand-bg)]/40"
        } focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[color:var(--color-brand-cyan)]`}
      >
        <td className="px-4 py-3">
          <p className="font-semibold text-[color:var(--color-brand-navy)]">
            {er.full_name}
          </p>
          {er.employee_number ? (
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              #{er.employee_number}
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {er.days_present}
          {er.scheduled_days > 0 ? ` / ${er.scheduled_days}` : ""}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatPhp(er.gross_pay_php)}
        </td>
        <td className="px-4 py-3 text-right font-bold tabular-nums text-[color:var(--color-brand-navy)]">
          {formatPhp(er.net_pay_php)}
        </td>
        <td className="px-4 py-3">
          <PayMethodPill method={er.payment_method} />
        </td>
        {showPayoutCell ? (
          <td
            className="px-4 py-3"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <PayoutCell employeeRun={er} />
          </td>
        ) : null}
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            {isSelected ? "Close" : "Edit lines"}
          </button>
        </td>
      </tr>
      {isInlineSelected ? (
        <tr className="bg-[color:var(--color-brand-bg)]/60">
          <td colSpan={tableColCount} className="px-4 py-4">
            {inlineDrawer}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// =============================================================================
// Drawer-style toggle
// =============================================================================

function DrawerStyleToggle({
  value,
  onChange,
}: {
  value: DrawerStyle;
  onChange: (next: DrawerStyle) => void;
}) {
  const items: { key: DrawerStyle; label: string }[] = [
    { key: "inline", label: "Inline" },
    { key: "slide-out", label: "Slide-out" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white">
      {items.map((i) => {
        const active = i.key === value;
        return (
          <button
            key={i.key}
            type="button"
            onClick={() => onChange(i.key)}
            className={`min-h-[44px] px-3 py-1.5 text-xs font-bold transition ${
              active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]"
            }`}
            aria-pressed={active}
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// PayoutCell -- per-employee post-finalise action (mark paid / void payout).
// Only mounted when the parent table is rendering the Payout column, which is
// gated on run.status in (finalised, voided). Each cell carries its own dialog
// + useTransition because the actions are independent per row.
// =============================================================================

function PayoutCell({ employeeRun }: { employeeRun: EmployeeRunRow }) {
  const router = useRouter();
  const [markOpen, setMarkOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  // Bank-only optional fields; reset on dialog close.
  const [paidAtLocalDate, setPaidAtLocalDate] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const closeAll = () => {
    if (isPending) return;
    setMarkOpen(false);
    setVoidOpen(false);
    setVoidReason("");
    setPaidAtLocalDate("");
    setBankReference("");
    setError(null);
  };

  const onConfirmMarkPaid = () => {
    setError(null);
    startTransition(async () => {
      const res = await markEmployeePaidAction({
        employee_run_id: employeeRun.id,
        // Bank-only; cash ignores. Empty strings become undefined so Zod
        // accepts a blank optional field instead of failing the regex.
        paid_at_local_date:
          employeeRun.payment_method === "bank" && paidAtLocalDate
            ? paidAtLocalDate
            : undefined,
        bank_reference:
          employeeRun.payment_method === "bank" && bankReference.trim()
            ? bankReference.trim()
            : undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMarkOpen(false);
      setPaidAtLocalDate("");
      setBankReference("");
      router.refresh();
    });
  };

  const onConfirmVoidPayout = () => {
    setError(null);
    startTransition(async () => {
      const res = await voidEmployeePayoutAction(
        employeeRun.id,
        voidReason.trim(),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setVoidOpen(false);
      setVoidReason("");
      router.refresh();
    });
  };

  // --- Pending branches ---------------------------------------------------
  if (employeeRun.payout_status === "pending") {
    const isCash = employeeRun.payment_method === "cash";
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setMarkOpen(true);
          }}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isCash ? "Mark paid (cash)" : "Mark paid"}
        </button>
        <ConfirmDialog
          open={markOpen}
          title={`Mark ${employeeRun.full_name} as paid?`}
          confirmLabel="Yes, mark paid"
          confirmVariant="success"
          cancelLabel="Cancel"
          isPending={isPending}
          onCancel={closeAll}
          onConfirm={onConfirmMarkPaid}
          errorMessage={error}
          body={
            <div className="space-y-3">
              <p>
                This records a {isCash ? "cash" : "bank"} payout of{" "}
                <strong>{formatPhp(employeeRun.net_pay_php)}</strong> to{" "}
                {employeeRun.full_name}.
                {isCash
                  ? " The action writes an eod_cash_adjustments row against today's active reception shift and posts the payout JE (DR 2360 Salaries Payable, CR 1010 Cash on Hand)."
                  : " The bridge posts the JE automatically (DR 2360 Salaries Payable, CR 1020 Bank)."}
              </p>
              {isCash ? (
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  The eod_cash_adjustments row will appear in the cash
                  drawer for today (Asia/Manila).
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs">
                    <span className="block font-semibold text-[color:var(--color-brand-text-mid)]">
                      Paid date (optional)
                    </span>
                    <input
                      type="date"
                      value={paidAtLocalDate}
                      onChange={(e) => setPaidAtLocalDate(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
                    />
                    <span className="mt-1 block text-[color:var(--color-brand-text-soft)]">
                      Leave blank for now.
                    </span>
                  </label>
                  <label className="text-xs">
                    <span className="block font-semibold text-[color:var(--color-brand-text-mid)]">
                      Bank reference (optional)
                    </span>
                    <input
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      maxLength={200}
                      value={bankReference}
                      onChange={(e) => setBankReference(e.target.value)}
                      placeholder="e.g. BPI ref 1234567"
                      className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-sm"
                    />
                    <span className="mt-1 block text-[color:var(--color-brand-text-soft)]">
                      Captured in the audit log.
                    </span>
                  </label>
                </div>
              )}
            </div>
          }
        />
      </>
    );
  }

  // --- Paid branch --------------------------------------------------------
  if (employeeRun.payout_status === "paid") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-900">
          Paid
        </span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setVoidReason("");
            setVoidOpen(true);
          }}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-bold text-rose-700 hover:border-rose-400 disabled:opacity-50"
        >
          Void payout
        </button>
        <ConfirmDialog
          open={voidOpen}
          title={`Void payout for ${employeeRun.full_name}?`}
          confirmLabel="Yes, void this payout"
          confirmVariant="danger"
          cancelLabel="Cancel"
          isPending={isPending}
          onCancel={closeAll}
          onConfirm={onConfirmVoidPayout}
          reasonRequired
          reasonValue={voidReason}
          onReasonChange={setVoidReason}
          errorMessage={error}
          body={
            <div className="space-y-3">
              <p>
                This reverses only this employee&apos;s payout JE. The gross-up
                JE remains; this employee&apos;s net pay stays in 2360 Salaries
                Payable until re-paid.
              </p>
            </div>
          }
        />
      </div>
    );
  }

  // --- Voided branch ------------------------------------------------------
  if (employeeRun.payout_status === "voided") {
    return (
      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700">
        Voided
      </span>
    );
  }

  // Defensive fallback for any future payout_status value.
  return (
    <span className="text-xs text-[color:var(--color-brand-text-soft)]">
      {employeeRun.payout_status}
    </span>
  );
}
