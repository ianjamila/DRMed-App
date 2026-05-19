"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatPeriodRange, formatManilaDate } from "@/lib/payroll/format";
import {
  uploadDtrAction,
  commitDtrAction,
  reconcileDtrEmployeeAction,
} from "./actions";

// =============================================================================
// Prop shapes
// =============================================================================

export interface RunHeader {
  id: string;
  period_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
}

export interface DtrImportRow {
  id: string;
  filename: string | null;
  parsed_rows_count: number;
  uploaded_at: string;
  uploader_name: string;
  is_current: boolean;
}

export interface StatusCounts {
  parsed: number;
  flagged_no_employee: number;
  flagged_missing_punch: number;
  superseded: number;
  other: number;
  total: number;
}

export interface DtrRowFlagged {
  id: string;
  external_id_raw: string;
  work_date: string;
  time_in: string | null;
  time_out: string | null;
  total_hours: number | null;
}

export interface EmployeeOption {
  id: string;
  full_name: string;
  employee_number: string | null;
}

interface Props {
  run: RunHeader;
  imports: DtrImportRow[];
  currentImportId: string | null;
  counts: StatusCounts;
  flaggedRows: DtrRowFlagged[];
  employees: EmployeeOption[];
}

// =============================================================================
// Helpers
// =============================================================================

const TS_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const TIME_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
});

function formatTs(iso: string): string {
  return TS_FMT.format(new Date(iso));
}

function formatRelative(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((nowMs - then) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  // time_in/time_out are stored as ISO timestamps; render in Manila.
  return TIME_FMT.format(new Date(iso));
}

// =============================================================================
// Component
// =============================================================================

type ParseSummary = {
  import_id: string;
  parsed: number;
  flagged_no_employee: number;
  flagged_missing_punch: number;
  errors: number;
};

export function DtrUploadClient({
  run,
  imports,
  currentImportId,
  counts,
  flaggedRows,
  employees,
}: Props) {
  const router = useRouter();
  const [csvText, setCsvText] = useState<string>("");
  const [filename, setFilename] = useState<string>("");
  const [parseSummary, setParseSummary] = useState<ParseSummary | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<boolean>(false);
  const [isParsing, startParseTransition] = useTransition();
  const [isCommitting, startCommitTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Mirrors `filename` so the parse transition can detect a stale race.
  const filenameRef = useRef<string>("");
  filenameRef.current = filename;

  // Stable "now" for relative timestamps so we don't tick on every render.
  const nowMs = useMemo(() => Date.now(), []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      setParseSummary(null);
      setParseError(null);
      setCommitError(null);
      setCommitted(false);
      if (!file) {
        setCsvText("");
        setFilename("");
        return;
      }
      // Cap CSV size before we ever read it into memory. 2 MB easily covers
      // a month of biometric punches for our staff size.
      if (file.size > 2 * 1024 * 1024) {
        setCsvText("");
        setFilename("");
        setParseError("File is too large (max 2 MB).");
        return;
      }
      setFilename(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        setCsvText(text);
      };
      reader.onerror = () => {
        setParseError("Could not read file.");
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleParse = useCallback(() => {
    setParseError(null);
    setCommitError(null);
    setCommitted(false);
    setParseSummary(null);
    if (!csvText || !filename) {
      setParseError("Pick a CSV file first.");
      return;
    }
    // Snapshot the filename at dispatch time. If the user races a second file
    // in before this transition resolves, we discard the stale result rather
    // than committing the wrong import. filenameRef is mirrored on every
    // render so it always reflects the latest picked file.
    const dispatchedFilename = filename;
    startParseTransition(async () => {
      const result = await uploadDtrAction({
        period_id: run.period_id,
        filename: dispatchedFilename,
        csv_text: csvText,
      });
      if (dispatchedFilename !== filenameRef.current) {
        // The picker changed mid-flight — drop this result silently.
        return;
      }
      if (!result.ok) {
        setParseError(result.error);
        return;
      }
      setParseSummary(result.data);
      // Pull in the freshly-inserted rows on the server.
      router.refresh();
    });
  }, [csvText, filename, run.period_id, router]);

  const handleCommit = useCallback(() => {
    if (!parseSummary) return;
    setCommitError(null);
    startCommitTransition(async () => {
      const result = await commitDtrAction(parseSummary.import_id);
      if (!result.ok) {
        setCommitError(result.error);
        return;
      }
      setCommitted(true);
      // Reset the picker so the next upload starts clean.
      setCsvText("");
      setFilename("");
      setParseSummary(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      router.refresh();
    });
  }, [parseSummary, router]);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <nav className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <Link
            href={`/staff/admin/payroll/runs/${run.id}`}
            className="inline-flex min-h-[28px] items-center rounded-md px-1 font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {"<-"} Back to run
          </Link>
          <span aria-hidden="true">|</span>
          <span>
            Pay runs :: {formatPeriodRange(run.period_start, run.period_end)}
          </span>
        </nav>
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Import DTR
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Upload the period&apos;s CSV from the biometric. Pay date{" "}
          {formatManilaDate(run.pay_date)}.
        </p>
      </header>

      {/* =========================================================== */}
      {/* Section A: Prior imports                                    */}
      {/* =========================================================== */}
      <section className="mb-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Prior imports
        </h2>
        {imports.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No DTR imported yet.
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <th className="px-4 py-3">Uploaded</th>
                    <th className="px-4 py-3">By</th>
                    <th className="px-4 py-3">Filename</th>
                    <th className="px-4 py-3 text-right">Rows parsed</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {imports.map((imp) => (
                    <tr key={imp.id}>
                      <td className="px-4 py-3 align-middle">
                        <div className="font-semibold text-[color:var(--color-brand-navy)]">
                          {formatTs(imp.uploaded_at)}
                        </div>
                        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {formatRelative(imp.uploaded_at, nowMs)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-middle text-xs">
                        {imp.uploader_name}
                      </td>
                      <td className="px-4 py-3 align-middle text-xs font-mono text-[color:var(--color-brand-text-mid)]">
                        {imp.filename ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-right align-middle font-semibold text-[color:var(--color-brand-navy)]">
                        {imp.parsed_rows_count}
                      </td>
                      <td className="px-4 py-3 align-middle">
                        <ImportStatusPill current={imp.is_current} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {imports.map((imp) => (
                <div
                  key={imp.id}
                  className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-[color:var(--color-brand-navy)]">
                        {formatTs(imp.uploaded_at)}
                      </div>
                      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {formatRelative(imp.uploaded_at, nowMs)} - by{" "}
                        {imp.uploader_name}
                      </div>
                    </div>
                    <ImportStatusPill current={imp.is_current} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Filename
                    </dt>
                    <dd className="truncate text-right font-mono">
                      {imp.filename ?? "-"}
                    </dd>
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Rows parsed
                    </dt>
                    <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
                      {imp.parsed_rows_count}
                    </dd>
                  </dl>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Current-import row-status counts */}
        {currentImportId ? (
          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            <CountTile label="Total rows" value={counts.total} />
            <CountTile
              label="Parsed"
              value={counts.parsed}
              accent="ok"
            />
            <CountTile
              label="No employee"
              value={counts.flagged_no_employee}
              accent={counts.flagged_no_employee > 0 ? "warn" : "neutral"}
            />
            <CountTile
              label="Missing punch"
              value={counts.flagged_missing_punch}
              accent={counts.flagged_missing_punch > 0 ? "warn" : "neutral"}
            />
            <CountTile label="Superseded" value={counts.superseded} />
          </dl>
        ) : null}
      </section>

      {/* =========================================================== */}
      {/* Section B: Upload new CSV                                   */}
      {/* =========================================================== */}
      <section className="mb-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Upload new CSV
        </h2>
        <p className="mb-4 text-sm text-[color:var(--color-brand-text-soft)]">
          Uploading a new CSV supersedes any earlier import for this period.
          Rows are parsed and persisted in one step.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            disabled={isParsing || isCommitting}
            className="block w-full text-sm text-[color:var(--color-brand-navy)] file:mr-3 file:min-h-[44px] file:cursor-pointer file:rounded-md file:border-0 file:bg-[color:var(--color-brand-bg)] file:px-4 file:py-2 file:text-sm file:font-bold file:text-[color:var(--color-brand-navy)] hover:file:bg-[color:var(--color-brand-bg-mid)] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleParse}
            disabled={!csvText || isParsing || isCommitting}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {isParsing ? "Parsing..." : "Parse"}
          </button>
        </div>

        {parseError ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {parseError}
          </p>
        ) : null}

        {parseSummary ? (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <CountTile
                label="Parsed"
                value={parseSummary.parsed}
                accent="ok"
              />
              <CountTile
                label="Flagged no employee"
                value={parseSummary.flagged_no_employee}
                accent={
                  parseSummary.flagged_no_employee > 0 ? "warn" : "neutral"
                }
              />
              <CountTile
                label="Flagged missing punch"
                value={parseSummary.flagged_missing_punch}
                accent={
                  parseSummary.flagged_missing_punch > 0 ? "warn" : "neutral"
                }
              />
              <CountTile
                label="Total rows"
                value={
                  parseSummary.parsed +
                  parseSummary.flagged_no_employee +
                  parseSummary.flagged_missing_punch
                }
              />
            </dl>

            {parseSummary.errors > 0 ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {parseSummary.errors} CSV row
                {parseSummary.errors === 1 ? "" : "s"} could not be parsed and{" "}
                were skipped. The errors are recorded on the import.
              </p>
            ) : null}

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handleCommit}
                disabled={isCommitting || committed}
                className="min-h-[44px] rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {isCommitting
                  ? "Committing..."
                  : committed
                    ? "Committed"
                    : "Commit import"}
              </button>
              {committed ? (
                <p className="self-center text-xs text-emerald-700">
                  Import committed. Review the rows below.
                </p>
              ) : null}
            </div>

            {commitError ? (
              <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {commitError}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {/* =========================================================== */}
      {/* Section C: Reconcile flagged rows                           */}
      {/* =========================================================== */}
      {flaggedRows.length > 0 ? (
        <section>
          <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Reconcile flagged rows
          </h2>
          <p className="mb-3 text-sm text-[color:var(--color-brand-text-soft)]">
            {flaggedRows.length} row
            {flaggedRows.length === 1 ? "" : "s"} could not be matched to an
            employee. Pick the correct employee and save to include them in this
            run.
          </p>

          {employees.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              No active employees to match against.
            </p>
          ) : (
            <ReconcileTable rows={flaggedRows} employees={employees} />
          )}
        </section>
      ) : null}
    </div>
  );
}

// =============================================================================
// Status pill
// =============================================================================

function ImportStatusPill({ current }: { current: boolean }) {
  return current ? (
    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
      Current
    </span>
  ) : (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
      Superseded
    </span>
  );
}

// =============================================================================
// Count tile
// =============================================================================

function CountTile({
  label,
  value,
  accent = "neutral",
}: {
  label: string;
  value: number;
  accent?: "neutral" | "ok" | "warn";
}) {
  const accentCls =
    accent === "ok"
      ? "text-emerald-700"
      : accent === "warn"
        ? "text-amber-700"
        : "text-[color:var(--color-brand-navy)]";
  return (
    <div className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </div>
      <div
        className={`mt-0.5 text-xl font-extrabold tabular-nums ${accentCls}`}
      >
        {value}
      </div>
    </div>
  );
}

// =============================================================================
// Reconcile table
// =============================================================================

interface ReconcileTableProps {
  rows: DtrRowFlagged[];
  employees: EmployeeOption[];
}

function ReconcileTable({ rows, employees }: ReconcileTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3">External ID</th>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Time in/out</th>
            <th className="px-4 py-3 text-right">Hours</th>
            <th className="px-4 py-3">Match employee</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {rows.map((row) => (
            <ReconcileRow key={row.id} row={row} employees={employees} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReconcileRow({
  row,
  employees,
}: {
  row: DtrRowFlagged;
  employees: EmployeeOption[];
}) {
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState<string>("");
  const [message, setMessage] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const onSave = () => {
    setMessage(null);
    if (!employeeId) {
      setMessage({ kind: "err", text: "Pick an employee." });
      return;
    }
    startTransition(async () => {
      const result = await reconcileDtrEmployeeAction(row.id, employeeId);
      if (!result.ok) {
        setMessage({ kind: "err", text: result.error });
        return;
      }
      setMessage({ kind: "ok", text: "Matched." });
      router.refresh();
    });
  };

  return (
    <tr>
      <td className="px-4 py-3 align-middle font-mono text-xs text-[color:var(--color-brand-text-mid)]">
        {row.external_id_raw}
      </td>
      <td className="px-4 py-3 align-middle text-xs">
        {formatManilaDate(row.work_date)}
      </td>
      <td className="px-4 py-3 align-middle text-xs">
        {formatTime(row.time_in)} - {formatTime(row.time_out)}
      </td>
      <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
        {row.total_hours === null ? "-" : row.total_hours.toFixed(2)}
      </td>
      <td className="px-4 py-3 align-middle">
        <select
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          disabled={isPending}
          className="w-full min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
        >
          <option value="">Pick employee...</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.full_name}
              {e.employee_number ? ` (${e.employee_number})` : ""}
            </option>
          ))}
        </select>
        {message ? (
          <p
            className={`mt-1 text-xs ${
              message.kind === "ok" ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3 align-middle">
        <button
          type="button"
          onClick={onSave}
          disabled={isPending || !employeeId}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
      </td>
    </tr>
  );
}
