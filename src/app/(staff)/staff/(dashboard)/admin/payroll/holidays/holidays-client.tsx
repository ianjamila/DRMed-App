"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import {
  addHolidayAction,
  removeHolidayAction,
} from "../config/actions";

// =============================================================================
// Prop shapes
// =============================================================================

export interface HolidayRow {
  id: string;
  date: string; // YYYY-MM-DD
  kind: string; // 'regular' | 'special_non_working' | 'special_working'
  name: string;
  notes: string | null;
  is_active: boolean;
}

type HolidayKind = "regular" | "special_non_working" | "special_working";

interface Props {
  holidays: HolidayRow[];
  years: number[];
  currentYear: number;
  defaultAddDate: string;
  error: string | null;
}

// =============================================================================
// Local formatters
// =============================================================================

// Locale-formatted "Mon, May 1" — keeps the weekday next to the date so the
// admin can sanity-check which day of the week a holiday lands on. Parsed
// as Manila wall-clock to dodge UTC drift on date-only strings.
const WEEKDAY_DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  weekday: "short",
  month: "short",
  day: "numeric",
});

function formatWeekdayDate(iso: string): string {
  if (!iso) return "-";
  return WEEKDAY_DATE_FMT.format(new Date(`${iso}T00:00:00+08:00`));
}

const KIND_LABEL: Record<string, string> = {
  regular: "Regular",
  special_non_working: "Special non-working",
  special_working: "Special working",
};

const KIND_PILL_CLS: Record<string, string> = {
  regular: "bg-amber-100 text-amber-900",
  special_non_working: "bg-sky-100 text-sky-900",
  special_working: "bg-slate-200 text-slate-700",
};

// =============================================================================
// Main client
// =============================================================================

const ROUTE = "/staff/admin/payroll/holidays";

export function HolidaysClient({
  holidays,
  years,
  currentYear,
  defaultAddDate,
  error,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const updateYear = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.set("year", value);
      const qs = next.toString();
      setActionError(null);
      startTransition(() => {
        router.replace(qs ? `${ROUTE}?${qs}` : ROUTE);
      });
    },
    [router, searchParams],
  );

  const handleDisable = useCallback(
    (holiday: HolidayRow) => {
      // window.confirm is acceptable for low-stakes destructive confirmations
      // (project convention — see employee detail's deactivate). We avoid
      // window.alert for errors; failures surface via actionError below.
      const ok = window.confirm(
        `Disable "${holiday.name}" on ${holiday.date}? Payroll runs will stop treating this date as a holiday going forward. Past runs are unaffected.`,
      );
      if (!ok) return;
      startTransition(async () => {
        const result = await removeHolidayAction(holiday.id);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        router.refresh();
      });
    },
    [router],
  );

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

      {/* Filter strip */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Year
          <select
            value={String(currentYear)}
            onChange={(e) => updateYear(e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] sm:block">
          {holidays.length}{" "}
          {holidays.length === 1 ? "holiday" : "holidays"}
        </p>

        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95 disabled:opacity-50"
        >
          + Add holiday
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {holidays.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No holidays recorded for {currentYear}.
                </td>
              </tr>
            ) : (
              holidays.map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-3 align-middle">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      {formatWeekdayDate(h.date)}
                    </div>
                    <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {h.date}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <KindPill kind={h.kind} />
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      {h.name}
                    </div>
                    {h.notes ? (
                      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {h.notes}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <StatusPill active={h.is_active} />
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    {h.is_active ? (
                      <button
                        type="button"
                        onClick={() => handleDisable(h)}
                        disabled={isPending}
                        className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                      >
                        Disable
                      </button>
                    ) : (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        Disabled (re-enable via DB)
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {holidays.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No holidays recorded for {currentYear}.
          </p>
        ) : (
          holidays.map((h) => (
            <div
              key={h.id}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {formatWeekdayDate(h.date)}
                  </div>
                  <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                    {h.date}
                  </div>
                </div>
                <StatusPill active={h.is_active} />
              </div>
              <div className="mt-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
                    {h.name}
                  </div>
                  {h.notes ? (
                    <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                      {h.notes}
                    </p>
                  ) : null}
                </div>
                <KindPill kind={h.kind} />
              </div>
              <div className="mt-3 flex justify-end">
                {h.is_active ? (
                  <button
                    type="button"
                    onClick={() => handleDisable(h)}
                    disabled={isPending}
                    className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
                  >
                    Disable
                  </button>
                ) : (
                  <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                    Disabled (re-enable via DB)
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add drawer — `key` remounts the drawer each time it opens, so the
          `useState` initialisers re-run with fresh defaults. This replaces a
          useEffect that called setState to re-prime the fields on open. */}
      <AddHolidayDrawer
        key={drawerOpen ? `open-${defaultAddDate}` : "closed"}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        defaultDate={defaultAddDate}
        onCreated={() => {
          setDrawerOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

// =============================================================================
// Pills
// =============================================================================

function KindPill({ kind }: { kind: string }) {
  const label = KIND_LABEL[kind] ?? kind;
  const cls = KIND_PILL_CLS[kind] ?? "bg-slate-200 text-slate-700";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}
    >
      {label}
    </span>
  );
}

function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
        Active
      </span>
    );
  }
  return (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
      Disabled
    </span>
  );
}

// =============================================================================
// Add drawer
// =============================================================================

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  defaultDate: string;
  onCreated: () => void;
}

function AddHolidayDrawer({
  open,
  onClose,
  defaultDate,
  onCreated,
}: DrawerProps) {
  const [date, setDate] = useState(defaultDate);
  const [kind, setKind] = useState<HolidayKind>("regular");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  // Lock body scroll + wire ESC to close while the drawer is open.
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

  // Field reset on open is handled by the parent passing a `key` that changes
  // whenever the drawer opens, which remounts this component and re-runs the
  // useState initialisers above. No reset effect needed.

  if (!open) return null;

  const submit = () => {
    setError(null);
    if (!date) {
      setError("Pick a date.");
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Name is required.");
      return;
    }
    startTransition(async () => {
      const result = await addHolidayAction({
        date,
        kind,
        name: trimmedName,
        notes: notes.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

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
        aria-labelledby="add-holiday-title"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <h2
            id="add-holiday-title"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
          >
            Add holiday
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
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as HolidayKind)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="regular">Regular (200% multiplier)</option>
              <option value="special_non_working">
                Special non-working (130% multiplier)
              </option>
              <option value="special_working">Special working</option>
            </select>
          </Field>

          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Labor Day"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Proclamation No. 90"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

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
            {isPending ? "Saving..." : "Add holiday"}
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
