"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
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

function useDrawerStylePreference(): [DrawerStyle, (next: DrawerStyle) => void] {
  const [style, setStyle] = useState<DrawerStyle>("inline");

  // Read from localStorage on mount only — avoid SSR/CSR hydration mismatch.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("payroll-run-drawer-style");
      if (raw === "inline" || raw === "slide-out") {
        setStyle(raw);
      }
    } catch {
      // Ignore — Storage may be blocked in private windows.
    }
  }, []);

  const update = (next: DrawerStyle) => {
    setStyle(next);
    try {
      window.localStorage.setItem("payroll-run-drawer-style", next);
    } catch {
      // Ignore.
    }
  };

  return [style, update];
}

// =============================================================================
// Top-level component
// =============================================================================

type DialogKind = "reimport" | "finalise" | "void-run";

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

  const closeDialog = () => {
    if (isHeaderPending) return;
    setOpenDialog(null);
    setVoidReason("");
    setDialogError(null);
  };

  const onRecompute = () => {
    setRecomputeError(null);
    startHeaderTransition(async () => {
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
    setOpenDialog(null);
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


  // Detect mobile viewport to force slide-out style. Tailwind's md breakpoint
  // is 768px; match that here so the toggle's effective state matches the
  // table layout below.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = () => setIsMobile(mq.matches);
    handler();
    // Older Safari uses addListener / removeListener; modern browsers use
    // addEventListener. Both are supported by MediaQueryList.
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
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

  const finaliserLabel = run.finaliser_name ?? "Not finalised yet";

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
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {employeeRuns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
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
            <button
              key={er.id}
              type="button"
              onClick={() => setSelectedEmployeeRunId(er.id)}
              className="block w-full min-h-[44px] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-left shadow-sm hover:border-[color:var(--color-brand-cyan)]"
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

    </div>
  );
}

// =============================================================================
// Run action cluster (header right side)
// =============================================================================

function RunActionCluster({
  status,
  isPending,
  voidRunDisabled,
  voidRunDisabledReason,
  onRecompute,
  onReimportClick,
  onFinaliseClick,
  onVoidRunClick,
}: {
  status: string;
  isPending: boolean;
  voidRunDisabled: boolean;
  voidRunDisabledReason: string | null;
  onRecompute: () => void;
  onReimportClick: () => void;
  onFinaliseClick: () => void;
  onVoidRunClick: () => void;
}) {
  if (status === "draft") {
    return (
      <button
        type="button"
        onClick={onRecompute}
        disabled={isPending}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        {isPending ? "Recomputing..." : "Recompute"}
      </button>
    );
  }

  if (status === "computed") {
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
          onClick={onRecompute}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Working..." : "Recompute"}
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
  onSelect,
  inlineDrawer,
}: {
  er: EmployeeRunRow;
  isSelected: boolean;
  drawerStyle: DrawerStyle;
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
          <td colSpan={6} className="px-4 py-4">
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
            className={`min-h-[36px] px-3 py-1.5 text-xs font-bold transition ${
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
