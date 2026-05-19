"use client";

import { useCallback, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Banknote,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Wallet,
} from "lucide-react";
import { formatPhp } from "@/lib/marketing/format";
import {
  getPayslipUrlAction,
  type EmployeePayslipAdminOption,
  type PayslipListItem,
  type YtdTotals,
} from "./actions";

type Props = {
  payslips: PayslipListItem[];
  ytd: YtdTotals;
  selectedYear: number;
  currentYear: number;
  isAdmin: boolean;
  selectedEmployeeId: string | null;
  adminEmployees: EmployeePayslipAdminOption[];
  hasEmployeeRecord: boolean;
  errorMessage: string | null;
  viewerFullName: string;
};

const STORAGE_KEY = "payslips-privacy";
const YTD_ID = "__ytd__";

// ---------------------------------------------------------------------------
// Privacy-mode preference (localStorage-backed, SSR-safe via
// useSyncExternalStore — mirrors the pattern used by run-review-client.tsx).
// ---------------------------------------------------------------------------

function subscribeToPrivacyStorage(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function readStoredPrivacy(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function getServerPrivacy(): boolean {
  return true;
}

function usePrivacyMode(): [boolean, () => void] {
  const privacyMode = useSyncExternalStore(
    subscribeToPrivacyStorage,
    readStoredPrivacy,
    getServerPrivacy,
  );

  const toggle = useCallback(() => {
    try {
      const next = !readStoredPrivacy();
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
      // Same-tab dispatch so useSyncExternalStore re-reads.
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: next ? "on" : "off" }),
      );
    } catch {
      // ignore
    }
  }, []);

  return [privacyMode, toggle];
}

// Format a Manila-zone date string like "2026-05-19" → "May 19, 2026".
function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(d);
}

function formatPeriodRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00+08:00`);
  const e = new Date(`${end}T00:00:00+08:00`);
  const sameMonth =
    s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  if (sameMonth) {
    return `${new Intl.DateTimeFormat("en-PH", {
      month: "short",
      day: "numeric",
      timeZone: "Asia/Manila",
    }).format(s)}–${new Intl.DateTimeFormat("en-PH", {
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Manila",
    }).format(e)}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export function PayslipsClient({
  payslips,
  ytd,
  selectedYear,
  currentYear,
  isAdmin,
  selectedEmployeeId,
  adminEmployees,
  hasEmployeeRecord,
  errorMessage,
  viewerFullName,
}: Props) {
  const router = useRouter();
  const [privacyMode, togglePrivacyStored] = usePrivacyMode();
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  function togglePrivacy() {
    setRevealedIds(new Set());
    togglePrivacyStored();
  }

  function toggleReveal(id: string) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Filter to selected year + sort latest first by pay_date.
  const yearFiltered = useMemo(() => {
    return payslips
      .filter((p) => Number(p.pay_date.slice(0, 4)) === selectedYear)
      .sort((a, b) => (a.pay_date < b.pay_date ? 1 : -1));
  }, [payslips, selectedYear]);

  const latest = yearFiltered[0] ?? null;
  const older = yearFiltered.slice(1);

  return (
    <div className="min-h-dvh bg-[color:var(--color-brand-bg)]">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {/* Top bar — back link + privacy toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/staff"
            className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[color:var(--color-brand-text-soft)] transition hover:bg-white hover:text-[color:var(--color-brand-navy)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
          <button
            type="button"
            onClick={togglePrivacy}
            aria-pressed={privacyMode}
            className="inline-flex h-11 min-w-[44px] items-center gap-2 rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-4 text-sm font-semibold text-[color:var(--color-brand-navy)] shadow-sm transition hover:bg-[color:var(--color-brand-bg-mid)]"
          >
            {privacyMode ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            <span>{privacyMode ? "Privacy: ON" : "Privacy: OFF"}</span>
          </button>
        </div>

        {/* Heading */}
        <header className="mt-4 sm:mt-6">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Payslips
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold leading-tight text-[color:var(--color-brand-navy)] sm:text-3xl">
            {selectedEmployeeId
              ? "Viewing another employee"
              : `Hi, ${viewerFullName.split(" ")[0]}`}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {privacyMode
              ? "Amounts are hidden. Tap a value to reveal it, or turn privacy off above."
              : "All amounts are visible. Turn privacy on to hide them."}
          </p>
        </header>

        {/* Admin controls */}
        {isAdmin && adminEmployees.length > 0 ? (
          <AdminEmployeePicker
            employees={adminEmployees}
            selectedEmployeeId={selectedEmployeeId}
            selectedYear={selectedYear}
          />
        ) : null}

        {/* Year tabs */}
        <YearTabs
          currentYear={currentYear}
          selectedYear={selectedYear}
          selectedEmployeeId={selectedEmployeeId}
        />

        {/* Error banner */}
        {errorMessage ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {errorMessage}
          </div>
        ) : null}

        {/* Body */}
        {!hasEmployeeRecord ? (
          <EmptyState
            title="Your employee record hasn't been set up yet."
            body="Contact admin to be added to the payroll roster."
          />
        ) : yearFiltered.length === 0 ? (
          <EmptyState
            title={`No payslips for ${selectedYear} yet.`}
            body="When a payroll run is paid out for this year, your payslip will appear here."
          />
        ) : (
          <>
            {latest ? (
              <LatestPayslipCard
                payslip={latest}
                privacyMode={privacyMode}
                isRevealed={revealedIds.has(latest.id)}
                onToggleReveal={() => toggleReveal(latest.id)}
                refreshOnDownload={() => router.refresh()}
              />
            ) : null}
            {older.length > 0 ? (
              <section className="mt-8">
                <h2 className="px-1 font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Earlier this year
                </h2>
                <ul className="mt-2 space-y-2">
                  {older.map((p) => (
                    <li key={p.id}>
                      <OlderPayslipCard
                        payslip={p}
                        privacyMode={privacyMode}
                        isRevealed={revealedIds.has(p.id)}
                        onToggleReveal={() => toggleReveal(p.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <YtdCard
              ytd={ytd}
              year={selectedYear}
              privacyMode={privacyMode}
              isRevealed={revealedIds.has(YTD_ID)}
              onToggleReveal={() => toggleReveal(YTD_ID)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Year tabs
// ---------------------------------------------------------------------------

function YearTabs({
  currentYear,
  selectedYear,
  selectedEmployeeId,
}: {
  currentYear: number;
  selectedYear: number;
  selectedEmployeeId: string | null;
}) {
  const years = [currentYear, currentYear - 1];

  function buildHref(year: number): string {
    const params = new URLSearchParams();
    if (selectedEmployeeId) params.set("employee_id", selectedEmployeeId);
    if (year !== currentYear) params.set("year", String(year));
    const qs = params.toString();
    return qs ? `/staff/payslips?${qs}` : "/staff/payslips";
  }

  return (
    <nav className="mt-5 flex gap-1 rounded-full bg-white p-1 shadow-sm" aria-label="Year">
      {years.map((y) => {
        const active = y === selectedYear;
        return (
          <Link
            key={y}
            href={buildHref(y)}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-11 flex-1 items-center justify-center rounded-full px-4 text-sm font-semibold transition ${
              active
                ? "bg-[color:var(--color-brand-navy)] text-white shadow"
                : "text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]"
            }`}
          >
            {y}
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Admin employee picker
// ---------------------------------------------------------------------------

function AdminEmployeePicker({
  employees,
  selectedEmployeeId,
  selectedYear,
}: {
  employees: EmployeePayslipAdminOption[];
  selectedEmployeeId: string | null;
  selectedYear: number;
}) {
  const router = useRouter();
  const currentYear = new Date().getFullYear();

  function onChange(value: string) {
    const params = new URLSearchParams();
    if (value) params.set("employee_id", value);
    if (selectedYear !== currentYear) params.set("year", String(selectedYear));
    const qs = params.toString();
    router.push(qs ? `/staff/payslips?${qs}` : "/staff/payslips");
  }

  return (
    <div className="mt-4 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3">
      <label
        htmlFor="admin-employee-picker"
        className="block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        Admin: view another employee
      </label>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative flex-1">
          <select
            id="admin-employee-picker"
            value={selectedEmployeeId ?? ""}
            onChange={(e) => onChange(e.target.value)}
            className="h-11 w-full appearance-none rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-3 pr-9 text-sm font-medium text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/30"
          >
            <option value="">Myself</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
                {e.employee_number ? ` — ${e.employee_number}` : ""}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-brand-text-soft)]" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Latest payslip card (gradient hero)
// ---------------------------------------------------------------------------

function LatestPayslipCard({
  payslip,
  privacyMode,
  isRevealed,
  onToggleReveal,
  refreshOnDownload,
}: {
  payslip: PayslipListItem;
  privacyMode: boolean;
  isRevealed: boolean;
  onToggleReveal: () => void;
  refreshOnDownload: () => void;
}) {
  const blurred = privacyMode && !isRevealed;
  return (
    <section className="mt-5 overflow-hidden rounded-3xl bg-gradient-to-br from-[color:var(--color-brand-navy)] via-[color:var(--color-brand-steel)] to-[color:var(--color-brand-cyan)] p-5 text-white shadow-lg sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/80">
            Latest net pay
          </p>
          <p className="mt-1 text-sm text-white/85">
            {formatPeriodRange(payslip.period_start, payslip.period_end)}
          </p>
        </div>
        <PaymentMethodPill method={payslip.payment_method_used} tone="dark" />
      </div>

      <button
        type="button"
        onClick={onToggleReveal}
        aria-label={blurred ? "Reveal net pay" : "Hide net pay"}
        className="mt-3 block w-full text-left"
      >
        <span
          className={`block font-[family-name:var(--font-heading)] text-4xl font-extrabold leading-tight transition select-none sm:text-5xl ${
            blurred ? "blur-md" : ""
          }`}
        >
          {formatPhp(payslip.net_pay_php)}
        </span>
      </button>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-white/85">
        <span>
          Paid {payslip.paid_at
            ? formatDate(payslip.paid_at.slice(0, 10))
            : formatDate(payslip.pay_date)}
        </span>
        <DownloadButton
          employeeRunId={payslip.id}
          hasFile={!!payslip.payslip_file_path}
          tone="dark"
          onSuccess={refreshOnDownload}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Older payslip card
// ---------------------------------------------------------------------------

function OlderPayslipCard({
  payslip,
  privacyMode,
  isRevealed,
  onToggleReveal,
}: {
  payslip: PayslipListItem;
  privacyMode: boolean;
  isRevealed: boolean;
  onToggleReveal: () => void;
}) {
  const blurred = privacyMode && !isRevealed;
  return (
    <article className="rounded-2xl bg-white p-4 shadow-sm transition hover:shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-[family-name:var(--font-heading)] text-sm font-bold text-[color:var(--color-brand-navy)]">
            {formatPeriodRange(payslip.period_start, payslip.period_end)}
          </p>
          <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
            Paid{" "}
            {payslip.paid_at
              ? formatDate(payslip.paid_at.slice(0, 10))
              : formatDate(payslip.pay_date)}
          </p>
        </div>
        <PaymentMethodPill method={payslip.payment_method_used} tone="light" />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggleReveal}
          aria-label={blurred ? "Reveal net pay" : "Hide net pay"}
          className="inline-flex min-h-11 items-center text-left"
        >
          <span
            className={`block font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)] transition select-none ${
              blurred ? "blur-md" : ""
            }`}
          >
            {formatPhp(payslip.net_pay_php)}
          </span>
        </button>
        <DownloadButton
          employeeRunId={payslip.id}
          hasFile={!!payslip.payslip_file_path}
          tone="light"
        />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// YTD totals card
// ---------------------------------------------------------------------------

function YtdCard({
  ytd,
  year,
  privacyMode,
  isRevealed,
  onToggleReveal,
}: {
  ytd: YtdTotals;
  year: number;
  privacyMode: boolean;
  isRevealed: boolean;
  onToggleReveal: () => void;
}) {
  const blurred = privacyMode && !isRevealed;
  return (
    <section className="mt-8 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
            Year-to-date · {year}
          </p>
          <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
            Across {ytd.payslip_count} paid payslip{ytd.payslip_count === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleReveal}
          aria-pressed={!blurred}
          aria-label={blurred ? "Reveal YTD totals" : "Hide YTD totals"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg-mid)] hover:text-[color:var(--color-brand-navy)]"
        >
          {blurred ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
      </div>

      <button
        type="button"
        onClick={onToggleReveal}
        aria-label={blurred ? "Reveal YTD totals" : "Hide YTD totals"}
        className="mt-3 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-3"
      >
        <YtdField
          label="Gross"
          value={ytd.gross_pay_php}
          blurred={blurred}
        />
        <YtdField
          label="Deductions"
          value={ytd.total_deductions_php}
          blurred={blurred}
        />
        <YtdField
          label="Net"
          value={ytd.net_pay_php}
          blurred={blurred}
          emphasised
        />
      </button>
    </section>
  );
}

function YtdField({
  label,
  value,
  blurred,
  emphasised = false,
}: {
  label: string;
  value: number;
  blurred: boolean;
  emphasised?: boolean;
}) {
  return (
    <div className="rounded-xl bg-[color:var(--color-brand-bg)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <span
        className={`mt-1 block font-[family-name:var(--font-heading)] font-extrabold transition select-none ${
          emphasised
            ? "text-2xl text-[color:var(--color-brand-navy)]"
            : "text-lg text-[color:var(--color-brand-text-mid)]"
        } ${blurred ? "blur-md" : ""}`}
      >
        {formatPhp(value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-8 rounded-3xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center">
      <p className="font-[family-name:var(--font-heading)] text-base font-bold text-[color:var(--color-brand-navy)]">
        {title}
      </p>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment method pill
// ---------------------------------------------------------------------------

function PaymentMethodPill({
  method,
  tone,
}: {
  method: "cash" | "bank" | null;
  tone: "dark" | "light";
}) {
  if (!method) return null;
  const Icon = method === "cash" ? Wallet : Banknote;
  const label = method === "cash" ? "Cash" : "Bank";
  if (tone === "dark") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-brand-bg)] px-2.5 py-1 text-xs font-semibold text-[color:var(--color-brand-navy)]">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Download button (opens signed URL in a new tab)
// ---------------------------------------------------------------------------

function DownloadButton({
  employeeRunId,
  hasFile,
  tone,
  onSuccess,
}: {
  employeeRunId: string;
  hasFile: boolean;
  tone: "dark" | "light";
  onSuccess?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const res = await getPayslipUrlAction(employeeRunId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Open in a new tab so we don't navigate away from the list.
      window.open(res.data.url, "_blank", "noopener,noreferrer");
      onSuccess?.();
    });
  }

  if (!hasFile) {
    return (
      <span
        className={`inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${
          tone === "dark"
            ? "bg-white/10 text-white/80"
            : "bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]"
        }`}
        title="PDF not generated yet — contact admin"
      >
        PDF not available
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={`inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition disabled:opacity-60 ${
          tone === "dark"
            ? "bg-white text-[color:var(--color-brand-navy)] hover:bg-white/90"
            : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg-mid)]"
        }`}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Download PDF
      </button>
      {error ? (
        <span
          className={`max-w-[12rem] text-right text-xs ${
            tone === "dark" ? "text-red-100" : "text-red-700"
          }`}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
