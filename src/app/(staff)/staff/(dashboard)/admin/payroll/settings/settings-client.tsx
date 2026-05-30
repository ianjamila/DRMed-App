"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePayrollSettingAction } from "../config/actions";

// =============================================================================
// Prop shapes
// =============================================================================

export interface SettingRow {
  id: string;
  key: string;
  value_php: number | null;
  description: string | null;
}

interface Props {
  rows: SettingRow[];
  error: string | null;
}

// =============================================================================
// Category derivation — driven by key prefix. The seed in migration 0044
// does not carry a category column, so we infer one for grouping the UI.
// =============================================================================

type Category =
  | "Tardiness"
  | "Schedule defaults"
  | "Night differential"
  | "Overtime"
  | "Holiday pay"
  | "Staff advance cap";

const CATEGORY_ORDER: ReadonlyArray<Category> = [
  "Tardiness",
  "Schedule defaults",
  "Night differential",
  "Overtime",
  "Holiday pay",
  "Staff advance cap",
];

function categoryFor(key: string): Category {
  if (key.startsWith("tardiness_") || key.startsWith("perfect_attendance_")) {
    return "Tardiness";
  }
  if (
    key.startsWith("standard_workday_") ||
    key.startsWith("scheduled_") ||
    key.startsWith("lunch_break_")
  ) {
    return "Schedule defaults";
  }
  if (key.startsWith("night_diff_")) return "Night differential";
  if (key.startsWith("ot_rate_")) return "Overtime";
  if (key.startsWith("holiday_pay_")) return "Holiday pay";
  if (key.startsWith("staff_advance_")) return "Staff advance cap";
  return "Schedule defaults";
}

// =============================================================================
// Per-key type/step hints. The DB stores everything as numeric value_php,
// but the input affordances differ by domain: integer hours/minutes vs.
// fractional rates/multipliers vs. peso amounts. Allowing arbitrary input
// keeps the editor permissive — the DB CHECK constraint is the real gate.
// =============================================================================

interface InputHint {
  step: string;
  min?: string;
  max?: string;
  suffix?: string;
  inputMode: "decimal" | "numeric";
}

const KEY_HINTS: Record<string, InputHint> = {
  tardiness_per_minute_php: { step: "0.01", min: "0", suffix: "PHP / min", inputMode: "decimal" },
  tardiness_threshold_for_halfday_deduction: { step: "1", min: "0", suffix: "instances", inputMode: "numeric" },
  perfect_attendance_bonus_php: { step: "1", min: "0", suffix: "PHP", inputMode: "decimal" },
  standard_workday_minutes: { step: "1", min: "0", max: "1440", suffix: "min", inputMode: "numeric" },
  scheduled_start_hour: { step: "1", min: "0", max: "23", suffix: "hour (0-23)", inputMode: "numeric" },
  scheduled_start_minute: { step: "1", min: "0", max: "59", suffix: "minute (0-59)", inputMode: "numeric" },
  scheduled_end_hour: { step: "1", min: "0", max: "23", suffix: "hour (0-23)", inputMode: "numeric" },
  scheduled_end_minute: { step: "1", min: "0", max: "59", suffix: "minute (0-59)", inputMode: "numeric" },
  lunch_break_minutes: { step: "1", min: "0", max: "240", suffix: "min", inputMode: "numeric" },
  night_diff_premium_rate: { step: "0.01", min: "0", max: "1", suffix: "fraction", inputMode: "decimal" },
  night_diff_start_hour: { step: "1", min: "0", max: "23", suffix: "hour (0-23)", inputMode: "numeric" },
  night_diff_end_hour: { step: "1", min: "0", max: "23", suffix: "hour (0-23)", inputMode: "numeric" },
  ot_rate_regular_day: { step: "0.01", min: "1", suffix: "multiplier", inputMode: "decimal" },
  ot_rate_rest_day: { step: "0.01", min: "1", suffix: "multiplier", inputMode: "decimal" },
  holiday_pay_regular_worked: { step: "0.01", min: "0", suffix: "multiplier", inputMode: "decimal" },
  holiday_pay_regular_unworked: { step: "0.01", min: "0", suffix: "multiplier", inputMode: "decimal" },
  holiday_pay_special_worked: { step: "0.01", min: "0", suffix: "multiplier", inputMode: "decimal" },
  holiday_pay_special_unworked: { step: "0.01", min: "0", suffix: "multiplier", inputMode: "decimal" },
  staff_advance_settlement_max_pct: { step: "0.01", min: "0", max: "1", suffix: "fraction", inputMode: "decimal" },
};

const DEFAULT_HINT: InputHint = { step: "0.01", min: "0", inputMode: "decimal" };

// =============================================================================
// Human-readable label from snake_case key.
//   "minutes_per_half_day" -> "Minutes per half day"
//   "tardiness_per_minute_php" -> "Tardiness per minute (PHP)"
// =============================================================================

function humanise(key: string): string {
  const replaced = key
    .replace(/_php$/, "_(PHP)")
    .replace(/_pct$/, "_(fraction)");
  const parts = replaced.split("_");
  return parts
    .map((p, i) => {
      if (p === "(PHP)" || p === "(fraction)") return p;
      if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1);
      return p;
    })
    .join(" ");
}

// =============================================================================
// Main client
// =============================================================================

export function SettingsClient({ rows, error }: Props) {
  const groups = useMemo(() => {
    const map = new Map<Category, SettingRow[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const r of rows) {
      const cat = categoryFor(r.key);
      map.get(cat)!.push(r);
    }
    return map;
  }, [rows]);

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {CATEGORY_ORDER.map((cat) => {
        const items = groups.get(cat) ?? [];
        if (items.length === 0) return null;
        return (
          <section
            key={cat}
            className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white"
          >
            <header className="border-b border-[color:var(--color-brand-bg-mid)] px-5 py-3">
              <h2 className="font-heading text-base font-extrabold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                {cat}
              </h2>
            </header>
            <ul className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {items.map((row) => (
                // Re-mount the row whenever the server-rendered value changes
                // (e.g. after router.refresh() following a successful save).
                // This replaces a useEffect(setValue(initial), [initial]) sync.
                <SettingItem
                  key={`${row.key}-${row.value_php ?? "null"}`}
                  row={row}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// =============================================================================
// One row = one editable setting with its own transition.
// =============================================================================

function SettingItem({ row }: { row: SettingRow }) {
  const router = useRouter();
  const hint = KEY_HINTS[row.key] ?? DEFAULT_HINT;
  const initial = row.value_php === null ? "" : String(row.value_php);

  // Controlled input: React 19 form-action would reset uncontrolled inputs on
  // the post-server re-render, which would silently discard edits on error.
  // Re-sync with `initial` is handled by the parent's key={row.key + value}
  // which remounts this component whenever the server-rendered value changes.
  const [value, setValue] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const isDirty = value !== initial;

  const save = () => {
    setError(null);
    setOk(null);
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("Value is required.");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setError("Enter a valid number.");
      return;
    }
    startTransition(async () => {
      const result = await updatePayrollSettingAction({
        key: row.key,
        value_php: parsed,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOk("Saved.");
      // Refresh so the server-rendered initial value updates.
      router.refresh();
    });
  };

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-6">
        {/* Label + description */}
        <div className="md:w-1/2">
          <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
            {humanise(row.key)}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-[color:var(--color-brand-text-soft)]">
            {row.key}
          </p>
          {row.description ? (
            <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
              {row.description}
            </p>
          ) : null}
        </div>

        {/* Editor */}
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode={hint.inputMode}
              step={hint.step}
              min={hint.min}
              max={hint.max}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setOk(null);
                setError(null);
              }}
              disabled={isPending}
              aria-label={`${humanise(row.key)} value`}
              className="min-h-[44px] w-40 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-mono focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
            />
            {hint.suffix ? (
              <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                {hint.suffix}
              </span>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={isPending || !isDirty}
              className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : ok ? (
            <p className="text-xs text-emerald-700">{ok}</p>
          ) : null}
        </div>
      </div>
    </li>
  );
}
