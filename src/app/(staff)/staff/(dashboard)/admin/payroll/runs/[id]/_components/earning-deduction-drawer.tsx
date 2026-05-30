"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatPhp } from "@/lib/marketing/format";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import type {
  EmployeeRunRow,
  EarningLineRow,
  DeductionLineRow,
} from "../run-review-client";
import {
  addEarningLineAction,
  addDeductionLineAction,
  removeEarningLineAction,
  removeDeductionLineAction,
} from "../../actions";
import { Panel } from "@/components/ui/panel";

// =============================================================================
// Component
// =============================================================================

type Variant = "inline" | "slide-out";

// Manual kinds are the only ones the AddEarningLineSchema accepts that admin
// will commonly add by hand. ot_supplement exists in the enum but is reserved
// for compute / OT-slip workflows — keep it out of the UI for now.
const MANUAL_EARNING_KINDS = [
  { value: "incentive", label: "Incentive" },
  { value: "one_time_bonus", label: "One-time bonus" },
  { value: "manual_adjustment", label: "Manual adjustment" },
] as const;
type ManualEarningKind = (typeof MANUAL_EARNING_KINDS)[number]["value"];

// loan_amortization is auto-managed by compute; admin can only add
// manual_adjustment / other deductions.
const MANUAL_DEDUCTION_KINDS = [
  { value: "manual_adjustment", label: "Manual adjustment" },
  { value: "other", label: "Other" },
] as const;
type ManualDeductionKind = (typeof MANUAL_DEDUCTION_KINDS)[number]["value"];

interface Props {
  variant: Variant;
  employeeRun: EmployeeRunRow;
  runStatus: string;
  onClose: () => void;
}

export function EarningDeductionDrawer({
  variant,
  employeeRun,
  runStatus,
  onClose,
}: Props) {
  const focusTrapRef = useFocusTrap<HTMLElement>(variant === "slide-out");

  // ESC closes the drawer in both variants; Inline drawer also responds, but
  // is much less likely to be confused with another modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while the slide-out is open. Inline mode leaves scroll
  // intact — the drawer is part of the document flow.
  useEffect(() => {
    if (variant !== "slide-out") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [variant]);

  const body = (
    <DrawerBody
      employeeRun={employeeRun}
      runStatus={runStatus}
    />
  );

  if (variant === "inline") {
    return (
      <Panel className="shadow-sm">
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-4 py-3">
          <div>
            <h3 className="font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
              {employeeRun.full_name}
            </h3>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Earnings &amp; deductions · {employeeRun.days_present} days present
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            Close
          </button>
        </div>
        {body}
      </Panel>
    );
  }

  // Slide-out: fixed right-edge panel + dimmed backdrop.
  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <aside
        ref={focusTrapRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Earnings and deductions for ${employeeRun.full_name}`}
        className="absolute right-0 top-0 flex h-full w-full flex-col bg-white shadow-2xl sm:max-w-[560px]"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
              {employeeRun.full_name}
            </h3>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Earnings &amp; deductions · {employeeRun.days_present} days present
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] rounded-md text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{body}</div>
      </aside>
    </div>
  );
}

// =============================================================================
// Drawer body (column layout shared between variants)
// =============================================================================

function DrawerBody({
  employeeRun,
  runStatus,
}: {
  employeeRun: EmployeeRunRow;
  runStatus: string;
}) {
  const editable = runStatus === "draft" || runStatus === "computed";

  // Build the synthesised "computed" line lists from aggregate columns. These
  // rows are read-only — they don't exist as payroll_earning_lines /
  // payroll_deduction_lines rows; they live on payroll_employee_runs columns.
  const computedEarnings = useMemo(
    () => buildComputedEarnings(employeeRun),
    [employeeRun],
  );
  const computedDeductions = useMemo(
    () => buildComputedDeductions(employeeRun),
    [employeeRun],
  );

  // The actual line rows. We split deductions into auto (loan_amortization
  // inserted by compute, no created_by) vs manual (admin-added). Earning lines
  // are admin-only today, but `created_by IS NULL` would mark anything the
  // compute path inserts in the future as auto.
  const earningLines = employeeRun.earnings;
  const autoLoanDeductions = employeeRun.deductions.filter(
    (l) => l.kind === "loan_amortization",
  );
  const manualDeductions = employeeRun.deductions.filter(
    (l) => l.kind !== "loan_amortization",
  );

  // Live net pay computed from the displayed lines. Mirrors the gross/net
  // shown on the run row, but keyed off the same data the user sees.
  const liveNet = useMemo(() => {
    const earningsTotal =
      computedEarnings.reduce((s, l) => s + l.amount_php, 0) +
      earningLines.reduce((s, l) => s + l.amount_php, 0);
    const deductionsTotal =
      computedDeductions.reduce((s, l) => s + l.amount_php, 0) +
      autoLoanDeductions.reduce((s, l) => s + l.amount_php, 0) +
      manualDeductions.reduce((s, l) => s + l.amount_php, 0);
    return earningsTotal - deductionsTotal;
  }, [
    computedEarnings,
    computedDeductions,
    earningLines,
    autoLoanDeductions,
    manualDeductions,
  ]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {!editable ? (
          <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            Run is {runStatus}. Lines are read-only.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <ColumnEarnings
            employeeRunId={employeeRun.id}
            editable={editable}
            computed={computedEarnings}
            lines={earningLines}
          />
          <ColumnDeductions
            employeeRunId={employeeRun.id}
            editable={editable}
            computed={computedDeductions}
            autoLoanLines={autoLoanDeductions}
            manualLines={manualDeductions}
          />
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] sm:px-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Net pay
          </span>
          <span className="font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
            {formatPhp(liveNet)}
          </span>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Earnings column
// =============================================================================

function ColumnEarnings({
  employeeRunId,
  editable,
  computed,
  lines,
}: {
  employeeRunId: string;
  editable: boolean;
  computed: SynthLine[];
  lines: EarningLineRow[];
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Earning lines
      </h4>
      <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white">
        {computed.length === 0 && lines.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-[color:var(--color-brand-text-soft)]">
            No earning lines yet.
          </p>
        ) : null}
        {computed.map((l) => (
          <SynthLineRow key={l.id} line={l} sign="+" />
        ))}
        {lines.map((line) => (
          <ManualEarningRow
            key={line.id}
            line={line}
            editable={editable}
          />
        ))}
      </div>
      {editable ? (
        <AddEarningForm employeeRunId={employeeRunId} />
      ) : null}
    </div>
  );
}

function ManualEarningRow({
  line,
  editable,
}: {
  line: EarningLineRow;
  editable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeEarningLineAction(line.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-amber-50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <span className="mr-2 rounded-sm bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
            manual
          </span>
          <span className="text-[color:var(--color-brand-navy)]">{line.label}</span>
        </div>
        <span className="tabular-nums font-semibold text-[color:var(--color-brand-navy)]">
          {formatPhp(line.amount_php)}
        </span>
        {editable ? (
          <button
            type="button"
            onClick={remove}
            disabled={isPending}
            className="ml-1 min-h-[44px] rounded-md px-2 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            aria-label={`Remove ${line.label}`}
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="px-3 pb-2 text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}

function AddEarningForm({ employeeRunId }: { employeeRunId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ManualEarningKind>("incentive");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full min-h-[44px] rounded-md border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-cyan)] hover:border-[color:var(--color-brand-cyan)]"
      >
        + Add manual earning
      </button>
    );
  }

  const submit = () => {
    setError(null);
    const amountN = Number(amount);
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }
    if (!Number.isFinite(amountN) || amountN < 0) {
      setError("Amount must be a non-negative number.");
      return;
    }
    startTransition(async () => {
      const result = await addEarningLineAction({
        employee_run_id: employeeRunId,
        kind,
        label: label.trim(),
        amount_php: amountN,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setKind("incentive");
      setLabel("");
      setAmount("");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="mt-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ManualEarningKind)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {MANUAL_EARNING_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[color:var(--color-brand-text-soft)]">
              ₱
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </div>
        </Field>
      </div>
      <div className="mt-2">
        <Field label="Label">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. HIV counselling x4"
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Adding..." : "Add earning"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Deductions column
// =============================================================================

function ColumnDeductions({
  employeeRunId,
  editable,
  computed,
  autoLoanLines,
  manualLines,
}: {
  employeeRunId: string;
  editable: boolean;
  computed: SynthLine[];
  autoLoanLines: DeductionLineRow[];
  manualLines: DeductionLineRow[];
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Deduction lines
      </h4>
      <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white">
        {computed.length === 0 &&
        autoLoanLines.length === 0 &&
        manualLines.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-[color:var(--color-brand-text-soft)]">
            No deduction lines yet.
          </p>
        ) : null}
        {computed.map((l) => (
          <SynthLineRow key={l.id} line={l} sign="−" />
        ))}
        {autoLoanLines.map((line) => (
          <AutoLoanRow key={line.id} line={line} />
        ))}
        {manualLines.map((line) => (
          <ManualDeductionRow key={line.id} line={line} editable={editable} />
        ))}
      </div>
      {editable ? (
        <AddDeductionForm employeeRunId={employeeRunId} />
      ) : null}
    </div>
  );
}

function AutoLoanRow({ line }: { line: DeductionLineRow }) {
  return (
    <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-slate-50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <span className="mr-2 rounded-sm bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-700">
            auto-loan
          </span>
          <span className="text-[color:var(--color-brand-navy)]">
            {line.label}
          </span>
        </div>
        <span className="tabular-nums font-semibold text-[color:var(--color-brand-navy)]">
          −{formatPhp(line.amount_php)}
        </span>
      </div>
    </div>
  );
}

function ManualDeductionRow({
  line,
  editable,
}: {
  line: DeductionLineRow;
  editable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeDeductionLineAction(line.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-amber-50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <span className="mr-2 rounded-sm bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
            manual
          </span>
          <span className="text-[color:var(--color-brand-navy)]">
            {line.label}
          </span>
        </div>
        <span className="tabular-nums font-semibold text-[color:var(--color-brand-navy)]">
          −{formatPhp(line.amount_php)}
        </span>
        {editable ? (
          <button
            type="button"
            onClick={remove}
            disabled={isPending}
            className="ml-1 min-h-[44px] rounded-md px-2 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            aria-label={`Remove ${line.label}`}
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="px-3 pb-2 text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}

function AddDeductionForm({ employeeRunId }: { employeeRunId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ManualDeductionKind>("manual_adjustment");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full min-h-[44px] rounded-md border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-cyan)] hover:border-[color:var(--color-brand-cyan)]"
      >
        + Add manual deduction
      </button>
    );
  }

  const submit = () => {
    setError(null);
    const amountN = Number(amount);
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }
    if (!Number.isFinite(amountN) || amountN < 0) {
      setError("Amount must be a non-negative number.");
      return;
    }
    startTransition(async () => {
      const result = await addDeductionLineAction({
        employee_run_id: employeeRunId,
        kind,
        label: label.trim(),
        amount_php: amountN,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setKind("manual_adjustment");
      setLabel("");
      setAmount("");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="mt-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ManualDeductionKind)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {MANUAL_DEDUCTION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[color:var(--color-brand-text-soft)]">
              ₱
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </div>
        </Field>
      </div>
      <div className="mt-2">
        <Field label="Label">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Uniform deduction"
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Adding..." : "Add deduction"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Synth (computed) line rows — sourced from payroll_employee_runs aggregates,
// not from the lines tables. Always read-only.
// =============================================================================

interface SynthLine {
  id: string;
  tag: string; // "computed" or "auto-loan" etc
  label: string;
  amount_php: number;
}

function SynthLineRow({ line, sign }: { line: SynthLine; sign: "+" | "−" }) {
  return (
    <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-slate-50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <span className="mr-2 rounded-sm bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-700">
            {line.tag}
          </span>
          <span className="text-[color:var(--color-brand-navy)]">
            {line.label}
          </span>
        </div>
        <span className="tabular-nums font-semibold text-[color:var(--color-brand-navy)]">
          {sign === "−" ? "−" : ""}
          {formatPhp(line.amount_php)}
        </span>
      </div>
    </div>
  );
}

function buildComputedEarnings(er: EmployeeRunRow): SynthLine[] {
  const out: SynthLine[] = [];
  const push = (key: string, label: string, amount: number) => {
    if (amount > 0)
      out.push({ id: `e-${key}`, tag: "computed", label, amount_php: amount });
  };
  push("basic", "Basic pay", er.basic_pay_php);
  push("allowances", "Allowances", er.allowances_total_php);
  push("ot", "OT pay", er.ot_pay_php);
  push("nightdiff", "Night differential", er.night_diff_pay_php);
  push("holiday", "Holiday pay", er.holiday_pay_php);
  push("incentives", "Incentives (computed)", er.incentives_total_php);
  push(
    "perfectatt",
    "Perfect attendance bonus",
    er.perfect_attendance_bonus_php,
  );
  push("thirteenth", "13th-month payout", er.thirteenth_month_payout_php);
  return out;
}

function buildComputedDeductions(er: EmployeeRunRow): SynthLine[] {
  const out: SynthLine[] = [];
  const push = (key: string, label: string, amount: number) => {
    if (amount > 0)
      out.push({ id: `d-${key}`, tag: "computed", label, amount_php: amount });
  };
  push("sss", "SSS EE", er.sss_ee_php);
  push("philhealth", "PhilHealth EE", er.philhealth_ee_php);
  push("pagibig", "Pag-IBIG EE", er.pagibig_ee_php);
  push("wt", "WT compensation", er.wt_compensation_php);
  push("tardiness", "Tardiness", er.tardiness_deduction_php);
  push(
    "advance",
    "Staff advance settlement",
    er.staff_advance_settlement_php,
  );
  return out;
}

// =============================================================================
// Field wrapper
// =============================================================================

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
    </label>
  );
}
