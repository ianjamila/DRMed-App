// Pure-TS payroll compute engine. Implements the 12-step pipeline per
// docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §6.
//
// Public entrypoint: `computePayrollRun(admin, runId)`. The function:
//   1. Loads the run + its period
//   2. Loads every payroll_employee_runs row (the slate of employees in the run)
//   3. Loads the relevant accounting_settings once
//   4. For each employee, runs the 12-step pipeline (attendance facts →
//      earnings → tardiness → 13th-month → gross → statutory → WT →
//      advance settlement → loan amortization → cap → write-back)
//   5. Flips payroll_runs.status from any-current-state to 'computed' and
//      stamps computed_at = now().
//
// This file is pure compute — it does NOT post any journal entries. The
// gross-up JE is the bridge trigger's job on finalise (see migration 0044 T29).
//
// All currency outputs are rounded to 2 decimal places (numeric(12,2)).
// All date math operates on `YYYY-MM-DD` strings (no TZ conversion). Time-of-
// day comparisons use the Asia/Manila timezone via Intl.DateTimeFormat.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ---------- Public result type ----------

export type ComputeResult =
  | { ok: true; updated: number }
  | { ok: false; error: string };

// ---------- Day-category enum ----------

export type DayCategory =
  | "present_regular"
  | "present_regular_holiday"
  | "present_special_holiday"
  | "unworked_regular_holiday"
  | "unworked_special_holiday"
  | "vl_used"
  | "sl_used"
  | "unpaid_absent"
  | "not_scheduled";

// ---------- Date / time helpers ----------

/**
 * Enumerate calendar days in `[startISODate, endISODate]` as `YYYY-MM-DD` strings.
 * Uses Date.UTC math to avoid TZ drift; the DB stores `date` (no time) so
 * string comparison on `YYYY-MM-DD` is well-defined.
 */
export function eachDayInPeriod(
  startISODate: string,
  endISODate: string,
): string[] {
  const [sy, sm, sd] = startISODate.split("-").map(Number);
  const [ey, em, ed] = endISODate.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

/**
 * Day-of-week for a `YYYY-MM-DD` string. 0 = Sun … 6 = Sat.
 */
export function dayOfWeek(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Parse a `timestamptz` ISO string and return the minutes-past-midnight in
 * the Asia/Manila local clock. e.g. "2026-05-19T01:08:00.000Z" → 9*60+8 = 548
 * (since UTC 01:08 = Manila 09:08).
 */
export function manilaMinutesPastMidnight(timestamptzIso: string): number {
  const dt = new Date(timestamptzIso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(dt);
  let hh = 0;
  let mm = 0;
  for (const p of parts) {
    if (p.type === "hour") hh = Number(p.value) % 24;
    if (p.type === "minute") mm = Number(p.value);
  }
  return hh * 60 + mm;
}

/**
 * Hours from a single time_in/time_out span (both `timestamptz` ISO) that
 * fall inside the night-differential window [22:00, 06:00 next day) in
 * Asia/Manila local time. Handles the cross-midnight case by clipping.
 *
 * Approximation: we work entirely in millisecond timestamps (UTC) and clip
 * against ND boundaries computed from the time_in's Manila calendar date.
 */
export function ndHoursInRange(
  timeInIso: string,
  timeOutIso: string,
): number {
  if (!timeInIso || !timeOutIso) return 0;
  const tin = new Date(timeInIso).getTime();
  const tout = new Date(timeOutIso).getTime();
  if (!Number.isFinite(tin) || !Number.isFinite(tout) || tout <= tin) return 0;

  // Build two candidate ND windows in Manila local time: one anchored to
  // time_in's calendar date (covers 22:00 same-day → 06:00 next-day) and
  // one anchored to the previous date (covers night that started yesterday).
  // Each window is a [startMs, endMs) pair in absolute time. Total ND hours
  // is sum of overlap with `[tin, tout)`.
  const anchorISO = manilaCalendarDate(timeInIso);
  const prevISO = addDaysISO(anchorISO, -1);
  const w1 = ndWindowMs(anchorISO); // [anchor 22:00, anchor+1 06:00)
  const w2 = ndWindowMs(prevISO); // [anchor-1 22:00, anchor 06:00)

  const overlapMs = (a: [number, number]) =>
    Math.max(0, Math.min(a[1], tout) - Math.max(a[0], tin));
  const total = overlapMs(w1) + overlapMs(w2);
  return total / 3_600_000;
}

/** Build an ND window `[manilaDate 22:00, manilaDate+1 06:00)` as UTC ms. */
function ndWindowMs(manilaDateISO: string): [number, number] {
  return [
    manilaLocalToUtcMs(manilaDateISO, 22, 0),
    manilaLocalToUtcMs(addDaysISO(manilaDateISO, 1), 6, 0),
  ];
}

/** Return the Manila calendar date (`YYYY-MM-DD`) of a `timestamptz` ISO. */
export function manilaCalendarDate(timestamptzIso: string): string {
  const dt = new Date(timestamptzIso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(dt); // en-CA → YYYY-MM-DD
}

/**
 * Convert a Manila local wall-clock (`date`, hh, mm) to UTC milliseconds.
 * Manila is fixed UTC+08:00 (no DST). Implementation: build the wall-clock
 * as if it were UTC, then subtract 8 hours.
 */
export function manilaLocalToUtcMs(
  manilaDateISO: string,
  hh: number,
  mm: number,
): number {
  const [y, mo, d] = manilaDateISO.split("-").map(Number);
  // Treat wall-clock as UTC, then offset by -8h to get the true UTC instant.
  return Date.UTC(y, mo - 1, d, hh, mm, 0) - 8 * 3_600_000;
}

/** Add `n` days (negative ok) to a `YYYY-MM-DD` string. */
export function addDaysISO(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Round to 2 decimals (banker's-free, classic half-up). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- Small typed aliases ----------

type ScheduleKind =
  | "fixed_5day_mon_fri"
  | "fixed_6day_mon_sat"
  | "shifting_5of6_mon_sat";

type HolidayRow = Database["public"]["Tables"]["payroll_holidays"]["Row"];
type DtrRow = Database["public"]["Tables"]["payroll_dtr_rows"]["Row"];
type LeaveRow =
  Database["public"]["Tables"]["employee_leave_records"]["Row"];
type EmployeeRow = Database["public"]["Tables"]["employees"]["Row"];
type AllowanceRow =
  Database["public"]["Tables"]["employee_allowances"]["Row"];
type OtSlipRow = Database["public"]["Tables"]["payroll_ot_slips"]["Row"];
type EarningLineRow =
  Database["public"]["Tables"]["payroll_earning_lines"]["Row"];
type DeductionLineRow =
  Database["public"]["Tables"]["payroll_deduction_lines"]["Row"];
type PeriodRow = Database["public"]["Tables"]["payroll_periods"]["Row"];
type EmployeeRunRow =
  Database["public"]["Tables"]["payroll_employee_runs"]["Row"];

/** Settings sourced from `accounting_settings`. All numeric. */
export type PayrollSettings = {
  tardiness_per_minute_php: number;
  tardiness_threshold_for_halfday_deduction: number;
  perfect_attendance_bonus_php: number;
  scheduled_start_hour: number;
  scheduled_start_minute: number;
  night_diff_premium_rate: number;
  ot_rate_regular_day: number;
  ot_rate_rest_day: number;
  holiday_pay_regular_worked: number;
  holiday_pay_regular_unworked: number;
  holiday_pay_special_worked: number;
  holiday_pay_special_unworked: number;
  standard_workday_minutes: number;
  staff_advance_settlement_max_pct: number;
};

const DEFAULT_SETTINGS: PayrollSettings = {
  tardiness_per_minute_php: 1.5,
  tardiness_threshold_for_halfday_deduction: 3,
  perfect_attendance_bonus_php: 1000,
  scheduled_start_hour: 8,
  scheduled_start_minute: 0,
  night_diff_premium_rate: 0.1,
  ot_rate_regular_day: 1.25,
  ot_rate_rest_day: 1.3,
  holiday_pay_regular_worked: 2.0,
  holiday_pay_regular_unworked: 1.0,
  holiday_pay_special_worked: 1.3,
  holiday_pay_special_unworked: 0,
  standard_workday_minutes: 480,
  staff_advance_settlement_max_pct: 0.5,
};

/**
 * Per-employee attendance facts pulled once at the top of the per-employee
 * loop. Holidays + scheduledDays are computed against the period.
 */
export type AttendanceFacts = {
  dtrByDate: Map<string, DtrRow>; // keyed by work_date (YYYY-MM-DD)
  holidayByDate: Map<string, HolidayRow>;
  leaveByDate: Map<string, { vl: number; sl: number }>; // VL/SL coverage days (sum of usage rows)
  scheduledByDate: Map<string, boolean>;
  calendarDays: string[];
};

// ---------- §6.0 Settings ----------

export async function loadSettings(
  admin: SupabaseClient<Database>,
): Promise<PayrollSettings> {
  const { data, error } = await admin
    .from("accounting_settings")
    .select("key, value_php")
    .in("key", [
      "tardiness_per_minute_php",
      "tardiness_threshold_for_halfday_deduction",
      "perfect_attendance_bonus_php",
      "scheduled_start_hour",
      "scheduled_start_minute",
      "night_diff_premium_rate",
      "ot_rate_regular_day",
      "ot_rate_rest_day",
      "holiday_pay_regular_worked",
      "holiday_pay_regular_unworked",
      "holiday_pay_special_worked",
      "holiday_pay_special_unworked",
      "standard_workday_minutes",
      "staff_advance_settlement_max_pct",
    ]);
  if (error) throw new Error(`loadSettings: ${error.message}`);
  const out: PayrollSettings = { ...DEFAULT_SETTINGS };
  for (const row of data ?? []) {
    const k = row.key as keyof PayrollSettings;
    if (row.value_php != null && k in out) {
      (out as Record<string, number>)[k] = Number(row.value_php);
    }
  }
  return out;
}

// ---------- §6.1 Attendance facts ----------

export async function pullAttendanceFacts(
  admin: SupabaseClient<Database>,
  period: Pick<PeriodRow, "id" | "period_start" | "period_end">,
  employee: Pick<EmployeeRow, "id" | "schedule_kind" | "rest_days">,
): Promise<AttendanceFacts> {
  // Find the latest non-superseded DTR import for the period. The plan
  // calls this "the latest import for period_id". We pick by uploaded_at DESC.
  const { data: imports, error: impErr } = await admin
    .from("payroll_dtr_imports")
    .select("id, uploaded_at")
    .eq("period_id", period.id)
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (impErr) throw new Error(`pullAttendanceFacts.imports: ${impErr.message}`);
  const latestImportId = imports?.[0]?.id ?? null;

  // The dtr-rows / holidays / leaves queries are mutually independent once
  // `latestImportId` is known, so fan them out with Promise.all.
  const [dtrResult, holidaysResult, leavesResult] = await Promise.all([
    latestImportId
      ? admin
          .from("payroll_dtr_rows")
          .select("*")
          .eq("import_id", latestImportId)
          .eq("employee_id", employee.id)
          .eq("status", "parsed")
      : Promise.resolve({ data: [] as DtrRow[], error: null }),
    admin
      .from("payroll_holidays")
      .select("*")
      .gte("date", period.period_start)
      .lte("date", period.period_end)
      .eq("is_active", true),
    admin
      .from("employee_leave_records")
      .select("*")
      .eq("employee_id", employee.id)
      .eq("record_kind", "usage")
      .gte("effective_date", period.period_start)
      .lte("effective_date", period.period_end),
  ]);
  if (dtrResult.error)
    throw new Error(`pullAttendanceFacts.rows: ${dtrResult.error.message}`);
  if (holidaysResult.error)
    throw new Error(`pullAttendanceFacts.holidays: ${holidaysResult.error.message}`);
  if (leavesResult.error)
    throw new Error(`pullAttendanceFacts.leaves: ${leavesResult.error.message}`);
  const dtrRows: DtrRow[] = (dtrResult.data ?? []) as DtrRow[];
  const holidays = holidaysResult.data;
  const leaves = leavesResult.data;

  const dtrByDate = new Map<string, DtrRow>();
  for (const row of dtrRows) {
    // Multiple DTR rows per date for the same employee shouldn't happen,
    // but defensively keep the first.
    if (!dtrByDate.has(row.work_date)) dtrByDate.set(row.work_date, row);
  }
  const holidayByDate = new Map<string, HolidayRow>();
  for (const h of holidays ?? []) {
    // Prefer 'regular' over 'special_*' if both happen (rare); fine to overwrite.
    holidayByDate.set(h.date, h);
  }
  const leaveByDate = new Map<string, { vl: number; sl: number }>();
  for (const lv of (leaves ?? []) as LeaveRow[]) {
    const existing = leaveByDate.get(lv.effective_date) ?? { vl: 0, sl: 0 };
    const absDelta = Math.abs(Number(lv.days_delta));
    if (lv.kind === "VL") existing.vl += absDelta;
    else if (lv.kind === "SL") existing.sl += absDelta;
    leaveByDate.set(lv.effective_date, existing);
  }

  const calendarDays = eachDayInPeriod(period.period_start, period.period_end);
  const scheduledByDate = new Map<string, boolean>();
  for (const d of calendarDays) {
    scheduledByDate.set(
      d,
      isScheduledDay(d, employee.schedule_kind as ScheduleKind, employee.rest_days),
    );
  }

  return {
    dtrByDate,
    holidayByDate,
    leaveByDate,
    scheduledByDate,
    calendarDays,
  };
}

/**
 * Whether `isoDate` is a scheduled work day for an employee with the given
 * schedule_kind. `shifting_5of6_mon_sat` returns false (presence-only — admin
 * adjusts in run review).
 */
export function isScheduledDay(
  isoDate: string,
  scheduleKind: ScheduleKind,
  restDays: number[] | null,
): boolean {
  const dow = dayOfWeek(isoDate); // 0=Sun..6=Sat
  if (restDays && restDays.includes(dow)) return false;
  switch (scheduleKind) {
    case "fixed_5day_mon_fri":
      return dow >= 1 && dow <= 5;
    case "fixed_6day_mon_sat":
      return dow >= 1 && dow <= 6;
    case "shifting_5of6_mon_sat":
      return false; // presence-only, admin adjusts
    default:
      return false;
  }
}

// ---------- §6.2 Categorise each day ----------

export function categoriseDay(
  isoDate: string,
  facts: AttendanceFacts,
): DayCategory {
  const dtr = facts.dtrByDate.get(isoDate);
  const holiday = facts.holidayByDate.get(isoDate);
  const leave = facts.leaveByDate.get(isoDate);
  const scheduled = facts.scheduledByDate.get(isoDate) ?? false;

  if (dtr) {
    if (holiday) {
      if (holiday.kind === "regular") return "present_regular_holiday";
      // both 'special_non_working' and 'special_working' use special pay rules
      return "present_special_holiday";
    }
    return "present_regular";
  }

  // No DTR row from here on.
  if (holiday) {
    if (holiday.kind === "regular" && scheduled) {
      return "unworked_regular_holiday";
    }
    if (
      (holiday.kind === "special_non_working" ||
        holiday.kind === "special_working") &&
      scheduled
    ) {
      return "unworked_special_holiday";
    }
    return "not_scheduled";
  }

  if (leave && leave.vl > 0) return "vl_used";
  if (leave && leave.sl > 0) return "sl_used";

  if (scheduled) return "unpaid_absent";
  return "not_scheduled";
}

// ---------- §6.3 Earnings ----------

export type DayCategoryCounts = {
  scheduled_days: number;
  days_present: number; // present_regular + present_*_holiday
  days_unpaid_absent: number;
  days_vl_used: number;
  days_sl_used: number;
  days_regular_holiday_worked: number;
  days_regular_holiday_unworked: number;
  days_special_holiday_worked: number;
  days_special_holiday_unworked: number;
};

export function countDayCategories(
  facts: AttendanceFacts,
  categories: Map<string, DayCategory>,
): DayCategoryCounts {
  let scheduled_days = 0;
  let days_present = 0;
  let days_unpaid_absent = 0;
  let days_vl_used = 0;
  let days_sl_used = 0;
  let days_regular_holiday_worked = 0;
  let days_regular_holiday_unworked = 0;
  let days_special_holiday_worked = 0;
  let days_special_holiday_unworked = 0;

  for (const d of facts.calendarDays) {
    if (facts.scheduledByDate.get(d)) scheduled_days += 1;
    switch (categories.get(d)) {
      case "present_regular":
        days_present += 1;
        break;
      case "present_regular_holiday":
        days_present += 1;
        days_regular_holiday_worked += 1;
        break;
      case "present_special_holiday":
        days_present += 1;
        days_special_holiday_worked += 1;
        break;
      case "unworked_regular_holiday":
        days_regular_holiday_unworked += 1;
        break;
      case "unworked_special_holiday":
        days_special_holiday_unworked += 1;
        break;
      case "vl_used":
        days_vl_used += 1;
        break;
      case "sl_used":
        days_sl_used += 1;
        break;
      case "unpaid_absent":
        days_unpaid_absent += 1;
        break;
      default:
        break;
    }
  }

  return {
    scheduled_days,
    days_present,
    days_unpaid_absent,
    days_vl_used,
    days_sl_used,
    days_regular_holiday_worked,
    days_regular_holiday_unworked,
    days_special_holiday_worked,
    days_special_holiday_unworked,
  };
}

export type EarningComponents = {
  basic_pay_php: number;
  allowances_total_php: number;
  ot_pay_php: number;
  night_diff_pay_php: number;
  holiday_pay_php: number;
  incentives_total_php: number;
  perfect_attendance_bonus_php: number;
  ot_overage_unpaid_minutes_total: number;
  missing_punch_days: number;
  non_taxable_allowance_per_day: number; // for §6.8 taxable calc
};

/**
 * Compute the earning components per §6.3.
 *
 * `basic_paid_days` = present_regular + present_*_holiday + vl_used + sl_used.
 */
export function computeEarnings(
  employee: Pick<EmployeeRow, "basic_daily_rate_php">,
  settings: PayrollSettings,
  allowances: AllowanceRow[],
  otSlips: OtSlipRow[],
  earningLines: EarningLineRow[],
  facts: AttendanceFacts,
  categories: Map<string, DayCategory>,
  counts: DayCategoryCounts,
): EarningComponents {
  const dailyRate = Number(employee.basic_daily_rate_php);
  const hourlyRate = dailyRate / (settings.standard_workday_minutes / 60);

  // Basic pay: presence + paid leaves.
  const basicPaidDays =
    counts.days_present + counts.days_vl_used + counts.days_sl_used;
  const basic_pay_php = round2(basicPaidDays * dailyRate);

  // Allowances: per-day amount × basic-paid-days, summed across active rows.
  let allowanceSum = 0;
  let nonTaxablePerDay = 0;
  for (const a of allowances) {
    const daily = Number(a.daily_amount_php);
    allowanceSum += daily * basicPaidDays;
    if (!a.is_taxable) nonTaxablePerDay += daily;
  }
  const allowances_total_php = round2(allowanceSum);
  const non_taxable_allowance_per_day = round2(nonTaxablePerDay);

  // OT pay: approved OT slips only. Rest-day multiplier composes with regular OT rate per spec.
  let otSum = 0;
  const restDaySet = new Set<string>();
  for (const d of facts.calendarDays) {
    if (!facts.scheduledByDate.get(d)) restDaySet.add(d);
  }
  for (const slip of otSlips) {
    if (slip.status !== "approved") continue;
    const hours = Number(slip.hours_requested);
    const isRest = restDaySet.has(slip.work_date);
    if (isRest) {
      otSum +=
        hours *
        hourlyRate *
        settings.ot_rate_rest_day *
        settings.ot_rate_regular_day;
    } else {
      otSum += hours * hourlyRate * settings.ot_rate_regular_day;
    }
  }
  const ot_pay_php = round2(otSum);

  // Night-differential: clip each DTR row's time_in/time_out against the ND
  // window in Manila local time, then multiply by hourly rate × premium.
  let ndHoursTotal = 0;
  let missing_punch_days = 0;
  let otOverageMinutes = 0;
  for (const row of facts.dtrByDate.values()) {
    if (row.time_in && row.time_out) {
      ndHoursTotal += ndHoursInRange(row.time_in, row.time_out);
    } else {
      missing_punch_days += 1;
    }
    if (row.total_hours != null) {
      const totalMin = Math.round(Number(row.total_hours) * 60);
      if (totalMin > settings.standard_workday_minutes) {
        const overageMin = totalMin - settings.standard_workday_minutes;
        const slip = otSlips.find(
          (s) => s.work_date === row.work_date && s.status === "approved",
        );
        if (!slip) otOverageMinutes += overageMin;
      }
    }
  }
  const night_diff_pay_php = round2(
    ndHoursTotal * hourlyRate * settings.night_diff_premium_rate,
  );

  // Holiday pay: per category, premium *over* the basic (the "-1" backs out
  // the basic_pay already counted for worked days).
  let holidaySum = 0;
  holidaySum +=
    counts.days_regular_holiday_worked *
    dailyRate *
    (settings.holiday_pay_regular_worked - 1);
  holidaySum +=
    counts.days_regular_holiday_unworked *
    dailyRate *
    settings.holiday_pay_regular_unworked;
  holidaySum +=
    counts.days_special_holiday_worked *
    dailyRate *
    (settings.holiday_pay_special_worked - 1);
  holidaySum +=
    counts.days_special_holiday_unworked *
    dailyRate *
    settings.holiday_pay_special_unworked;
  const holiday_pay_php = round2(holidaySum);

  // Incentives + manual: sum every payroll_earning_lines row regardless of kind.
  let incentives = 0;
  for (const line of earningLines) incentives += Number(line.amount_php);
  const incentives_total_php = round2(incentives);

  // Perfect-attendance bonus is set AFTER tardiness is known; tentatively 0 here.
  // The orchestrator sets the final value once tardiness is computed.
  const perfect_attendance_bonus_php = 0;

  return {
    basic_pay_php,
    allowances_total_php,
    ot_pay_php,
    night_diff_pay_php,
    holiday_pay_php,
    incentives_total_php,
    perfect_attendance_bonus_php,
    ot_overage_unpaid_minutes_total: otOverageMinutes,
    missing_punch_days,
    non_taxable_allowance_per_day,
  };
}

// ---------- §6.4 Tardiness ----------

export type TardinessResult = {
  minutes_late_total: number;
  tardiness_count: number;
  tardiness_deduction_php: number;
};

export function computeTardiness(
  facts: AttendanceFacts,
  categories: Map<string, DayCategory>,
  settings: PayrollSettings,
  basicDailyRate: number,
): TardinessResult {
  let minutes_late_total = 0;
  let tardiness_count = 0;
  const scheduledStartMin =
    settings.scheduled_start_hour * 60 + settings.scheduled_start_minute;
  for (const [date, cat] of categories) {
    if (
      cat !== "present_regular" &&
      cat !== "present_regular_holiday" &&
      cat !== "present_special_holiday"
    ) {
      continue;
    }
    const row = facts.dtrByDate.get(date);
    if (!row?.time_in) continue;
    const actualMin = manilaMinutesPastMidnight(row.time_in);
    const lateMin = Math.max(0, actualMin - scheduledStartMin);
    if (lateMin > 0) {
      tardiness_count += 1;
      minutes_late_total += lateMin;
    }
  }
  let deduction = minutes_late_total * settings.tardiness_per_minute_php;
  if (tardiness_count >= settings.tardiness_threshold_for_halfday_deduction) {
    deduction += basicDailyRate / 2;
  }
  return {
    minutes_late_total,
    tardiness_count,
    tardiness_deduction_php: round2(deduction),
  };
}

// ---------- §6.5 13th-month ----------

export type ThirteenthMonthResult = {
  thirteenth_month_accrual_php: number;
  thirteenth_month_payout_php: number;
};

export async function compute13thMonth(
  admin: SupabaseClient<Database>,
  employeeId: string,
  periodStartISO: string,
  basicPayPhp: number,
): Promise<ThirteenthMonthResult> {
  const accrual = round2(basicPayPhp / 12);

  // Payout only on the Dec 1-cutoff (period_start = YYYY-12-01).
  const [year, month, day] = periodStartISO.split("-").map(Number);
  let payout = 0;
  if (month === 12 && day === 1) {
    const yearStart = `${year}-01-01`;
    const periodStartExclusive = periodStartISO;
    // Sum prior accruals for this employee for the calendar year. We join
    // payroll_employee_runs → payroll_runs → payroll_periods.period_start
    // and filter to runs whose period_start is in [Jan 1, Dec 1). The
    // gte/lt below use PostgREST's nested-relation filter against the joined
    // payroll_runs.payroll_periods.period_start column so the year window is
    // enforced server-side instead of in JS.
    const { data, error } = await admin
      .from("payroll_employee_runs")
      .select(
        "thirteenth_month_accrual_php, payroll_runs!inner(payroll_periods!inner(period_start))",
      )
      .eq("employee_id", employeeId)
      .gte("payroll_runs.payroll_periods.period_start", yearStart)
      .lt("payroll_runs.payroll_periods.period_start", periodStartExclusive);
    if (error) {
      throw new Error(`compute13thMonth: ${error.message}`);
    }
    let priorSum = 0;
    type Joined = {
      thirteenth_month_accrual_php: number;
      payroll_runs: { payroll_periods: { period_start: string } } | null;
    };
    for (const row of (data ?? []) as unknown as Joined[]) {
      const ps = row.payroll_runs?.payroll_periods?.period_start;
      // Defensive JS-side backstop in case the join returns rows whose
      // period_start somehow falls outside the requested window (e.g. driver
      // version mismatch). Cheap; keeps the smoke deterministic.
      if (!ps) continue;
      if (ps >= yearStart && ps < periodStartExclusive) {
        priorSum += Number(row.thirteenth_month_accrual_php);
      }
    }
    payout = round2(priorSum + accrual);
  }

  return {
    thirteenth_month_accrual_php: accrual,
    thirteenth_month_payout_php: round2(payout),
  };
}

// ---------- §6.7 Statutory deductions ----------

export type StatutoryDeductions = {
  sss_ee_php: number;
  sss_er_php: number;
  philhealth_ee_php: number;
  philhealth_er_php: number;
  pagibig_ee_php: number;
  pagibig_er_php: number;
};

export async function computeStatutory(
  admin: SupabaseClient<Database>,
  monthlySalaryCredit: number,
  periodEndISO: string,
): Promise<StatutoryDeductions> {
  async function lookup(kind: "sss" | "philhealth" | "pagibig") {
    const { data, error } = await admin
      .from("payroll_contribution_brackets")
      .select(
        "employee_share_php, employer_share_php, monthly_salary_credit_min_php, monthly_salary_credit_max_php, effective_from, effective_to",
      )
      .eq("kind", kind)
      .lte("effective_from", periodEndISO)
      .lte("monthly_salary_credit_min_php", monthlySalaryCredit)
      .gte("monthly_salary_credit_max_php", monthlySalaryCredit)
      .or(`effective_to.is.null,effective_to.gte.${periodEndISO}`);
    if (error) throw new Error(`computeStatutory.${kind}: ${error.message}`);
    // Pick the row with the most recent `effective_from` (latest active bracket).
    const sorted = [...(data ?? [])].sort((a, b) =>
      a.effective_from < b.effective_from ? 1 : -1,
    );
    const top = sorted[0];
    if (!top) return { ee: 0, er: 0 };
    return {
      ee: Number(top.employee_share_php),
      er: Number(top.employer_share_php),
    };
  }
  const [sss, phil, pag] = await Promise.all([
    lookup("sss"),
    lookup("philhealth"),
    lookup("pagibig"),
  ]);
  return {
    sss_ee_php: round2(sss.ee / 2),
    sss_er_php: round2(sss.er / 2),
    philhealth_ee_php: round2(phil.ee / 2),
    philhealth_er_php: round2(phil.er / 2),
    pagibig_ee_php: round2(pag.ee / 2),
    pagibig_er_php: round2(pag.er / 2),
  };
}

// ---------- §6.8 WT compensation ----------

export async function computeWt(
  admin: SupabaseClient<Database>,
  taxableCompensation: number,
  periodEndISO: string,
): Promise<number> {
  if (taxableCompensation <= 0) return 0;
  const { data, error } = await admin
    .from("payroll_wt_brackets")
    .select(
      "taxable_min_php, taxable_max_php, base_tax_php, marginal_rate, effective_from, effective_to",
    )
    .lte("effective_from", periodEndISO)
    .or(`effective_to.is.null,effective_to.gte.${periodEndISO}`);
  if (error) throw new Error(`computeWt: ${error.message}`);
  // Find the bracket where taxable_min ≤ taxable < taxable_max (or max IS NULL).
  // Sort by effective_from DESC, then by taxable_min DESC, and pick the first match.
  const sorted = [...(data ?? [])].sort((a, b) => {
    if (a.effective_from !== b.effective_from) {
      return a.effective_from < b.effective_from ? 1 : -1;
    }
    return Number(a.taxable_min_php) < Number(b.taxable_min_php) ? 1 : -1;
  });
  for (const row of sorted) {
    const lo = Number(row.taxable_min_php);
    const hi = row.taxable_max_php == null ? Infinity : Number(row.taxable_max_php);
    if (taxableCompensation >= lo && taxableCompensation < hi) {
      const wt =
        Number(row.base_tax_php) +
        (taxableCompensation - lo) * Number(row.marginal_rate);
      return round2(wt);
    }
  }
  return 0;
}

// ---------- §6.9 Staff advance settlement ----------

export async function computeStaffAdvanceSettlement(
  admin: SupabaseClient<Database>,
  staffProfileId: string,
  grossPhp: number,
  statutoryEeSum: number,
  wtPhp: number,
  tardinessPhp: number,
  capPct: number,
): Promise<number> {
  const { data, error } = await admin
    .from("staff_advances")
    .select("outstanding_balance_php")
    .eq("staff_id", staffProfileId)
    .eq("status", "outstanding");
  if (error)
    throw new Error(`computeStaffAdvanceSettlement: ${error.message}`);
  let outstanding = 0;
  for (const row of data ?? [])
    outstanding += Number(row.outstanding_balance_php);
  const postStatNet = grossPhp - statutoryEeSum - wtPhp - tardinessPhp;
  const maxDeduction = Math.max(0, postStatNet) * capPct;
  return round2(Math.min(outstanding, maxDeduction));
}

// ---------- §6.10 Loan amortization auto-population ----------

/**
 * Delete-and-recreate the `loan_amortization` deduction lines for this employee_run.
 * Returns the inserted rows so the caller can apply the cap in insertion order.
 */
export async function recreateLoanAmortizationLines(
  admin: SupabaseClient<Database>,
  employeeRunId: string,
  employeeId: string,
  periodStartISO: string,
): Promise<DeductionLineRow[]> {
  // 1. Delete existing.
  const { error: delErr } = await admin
    .from("payroll_deduction_lines")
    .delete()
    .eq("employee_run_id", employeeRunId)
    .eq("kind", "loan_amortization");
  if (delErr)
    throw new Error(`recreateLoanAmortizationLines.delete: ${delErr.message}`);

  // 2. Fetch active loans for this employee whose start_period_id's period_start ≤ period.period_start.
  const { data: loans, error: loanErr } = await admin
    .from("employee_loans")
    .select(
      "id, amortization_per_period_php, notes, start_period_id, created_at, payroll_periods:start_period_id (period_start)",
    )
    .eq("employee_id", employeeId)
    .eq("status", "active")
    .not("start_period_id", "is", null)
    .order("created_at", { ascending: true });
  if (loanErr)
    throw new Error(`recreateLoanAmortizationLines.loans: ${loanErr.message}`);

  type LoanJoined = {
    id: string;
    amortization_per_period_php: number;
    notes: string | null;
    start_period_id: string | null;
    created_at: string;
    payroll_periods: { period_start: string } | null;
  };
  const eligible = ((loans ?? []) as unknown as LoanJoined[]).filter((l) => {
    const ps = l.payroll_periods?.period_start;
    return !!ps && ps <= periodStartISO;
  });

  if (eligible.length === 0) return [];

  const inserts = eligible.map((l) => ({
    employee_run_id: employeeRunId,
    kind: "loan_amortization",
    label: `Loan amortization — ${
      l.notes ?? `loan #${l.id.slice(0, 8)}`
    }`,
    amount_php: round2(Number(l.amortization_per_period_php)),
    loan_id: l.id,
  }));
  const { data: inserted, error: insErr } = await admin
    .from("payroll_deduction_lines")
    .insert(inserts)
    .select("*");
  if (insErr)
    throw new Error(`recreateLoanAmortizationLines.insert: ${insErr.message}`);
  // Preserve insertion order (oldest loan first per `created_at ASC` query).
  return (inserted ?? []) as DeductionLineRow[];
}

// ---------- §6.11 Deduction cap ----------

export type CappedDeductions = {
  statutory_capped: number;
  wt_capped: number;
  tardiness_capped: number;
  advance_capped: number;
  other_total_capped: number;
  net_pay_php: number;
  capped_lines: Array<{ id: string; amount_php: number }>;
};

export function applyDeductionCap(
  grossPhp: number,
  statutorySum: number,
  wtPhp: number,
  tardinessPhp: number,
  advancePhp: number,
  otherLines: Array<{ id: string; amount_php: number }>,
): CappedDeductions {
  let remaining = round2(grossPhp);
  const cap = (d: number): number => {
    const v = round2(Math.max(0, d));
    if (v <= remaining) {
      remaining = round2(remaining - v);
      return v;
    }
    const out = remaining;
    remaining = 0;
    return out;
  };

  const statutory_capped = cap(statutorySum);
  const wt_capped = cap(wtPhp);
  const tardiness_capped = cap(tardinessPhp);
  const advance_capped = cap(advancePhp);

  let other_total_capped = 0;
  const capped_lines: Array<{ id: string; amount_php: number }> = [];
  for (const line of otherLines) {
    const v = cap(Number(line.amount_php));
    other_total_capped = round2(other_total_capped + v);
    capped_lines.push({ id: line.id, amount_php: v });
  }

  return {
    statutory_capped,
    wt_capped,
    tardiness_capped,
    advance_capped,
    other_total_capped,
    net_pay_php: round2(remaining),
    capped_lines,
  };
}

// ---------- Main pipeline ----------

export async function computePayrollRun(
  admin: SupabaseClient<Database>,
  runId: string,
): Promise<ComputeResult> {
  try {
    // 1. Load run.
    const { data: run, error: runErr } = await admin
      .from("payroll_runs")
      .select("id, period_id, status")
      .eq("id", runId)
      .single();
    if (runErr || !run) {
      return { ok: false, error: `Run not found: ${runErr?.message ?? runId}` };
    }

    // 2. Load period.
    const { data: period, error: pErr } = await admin
      .from("payroll_periods")
      .select("id, period_start, period_end, pay_date")
      .eq("id", run.period_id)
      .single();
    if (pErr || !period) {
      return { ok: false, error: `Period not found: ${pErr?.message ?? ""}` };
    }

    // 3. Load all employee_runs for this run.
    const { data: emplRuns, error: erErr } = await admin
      .from("payroll_employee_runs")
      .select("id, employee_id, run_id")
      .eq("run_id", runId);
    if (erErr) {
      return { ok: false, error: `Load employee_runs: ${erErr.message}` };
    }
    const employeeRuns = (emplRuns ?? []) as Pick<
      EmployeeRunRow,
      "id" | "employee_id" | "run_id"
    >[];
    if (employeeRuns.length === 0) {
      // Nothing to compute, but still flip the run state.
      try {
        await flipRunToComputed(admin, runId);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      return { ok: true, updated: 0 };
    }

    // 4. Load shared settings once.
    const settings = await loadSettings(admin);

    // 5. Per-employee loop.
    let updatedCount = 0;
    for (const er of employeeRuns) {
      // 5a. Load the employee row (basic_daily_rate, schedule_kind, msc, staff_profile_id).
      const { data: empl, error: emplErr } = await admin
        .from("employees")
        .select(
          "id, staff_profile_id, basic_daily_rate_php, monthly_salary_credit_php, schedule_kind, rest_days",
        )
        .eq("id", er.employee_id)
        .single();
      if (emplErr || !empl) {
        return {
          ok: false,
          error: `Load employee ${er.employee_id}: ${emplErr?.message ?? ""}`,
        };
      }

      // 5b–5e. Fan out the four independent per-employee reads: attendance
      // facts (§6.1), allowances, approved OT slips, and earning lines. They
      // all feed into `computeEarnings` (5f) and have no inter-dependency, so
      // running them sequentially was a pure latency tax.
      const [factsResult, allowancesResult, otSlipsResult, earningLinesResult] =
        await Promise.all([
          pullAttendanceFacts(admin, period, empl),
          admin
            .from("employee_allowances")
            .select("*")
            .eq("employee_id", er.employee_id)
            .lte("effective_from", period.period_end)
            .or(`effective_to.is.null,effective_to.gte.${period.period_start}`),
          admin
            .from("payroll_ot_slips")
            .select("*")
            .eq("employee_id", er.employee_id)
            .eq("status", "approved")
            .gte("work_date", period.period_start)
            .lte("work_date", period.period_end),
          admin
            .from("payroll_earning_lines")
            .select("*")
            .eq("employee_run_id", er.id),
        ]);
      const facts = factsResult;
      const categories = new Map<string, DayCategory>();
      for (const d of facts.calendarDays) {
        categories.set(d, categoriseDay(d, facts));
      }
      const counts = countDayCategories(facts, categories);

      if (allowancesResult.error) {
        return {
          ok: false,
          error: `Load allowances: ${allowancesResult.error.message}`,
        };
      }
      const allowances = allowancesResult.data;

      if (otSlipsResult.error) {
        return {
          ok: false,
          error: `Load OT slips: ${otSlipsResult.error.message}`,
        };
      }
      const otSlips = otSlipsResult.data;

      if (earningLinesResult.error) {
        return {
          ok: false,
          error: `Load earning lines: ${earningLinesResult.error.message}`,
        };
      }
      const earningLines = earningLinesResult.data;

      // 5f. §6.3 earnings.
      const earnings = computeEarnings(
        empl,
        settings,
        (allowances ?? []) as AllowanceRow[],
        (otSlips ?? []) as OtSlipRow[],
        (earningLines ?? []) as EarningLineRow[],
        facts,
        categories,
        counts,
      );

      // 5g. §6.4 tardiness.
      const tardiness = computeTardiness(
        facts,
        categories,
        settings,
        Number(empl.basic_daily_rate_php),
      );

      // 5h. Perfect attendance bonus (post-tardiness check).
      const perfectAttendance =
        tardiness.tardiness_count === 0 &&
        counts.days_unpaid_absent === 0 &&
        earnings.missing_punch_days === 0
          ? round2(settings.perfect_attendance_bonus_php)
          : 0;

      // 5i. §6.5 13th-month.
      const thirteenth = await compute13thMonth(
        admin,
        er.employee_id,
        period.period_start,
        earnings.basic_pay_php,
      );

      // 5j. §6.6 gross.
      const gross_pay_php = round2(
        earnings.basic_pay_php +
          earnings.allowances_total_php +
          earnings.ot_pay_php +
          earnings.night_diff_pay_php +
          earnings.holiday_pay_php +
          earnings.incentives_total_php +
          perfectAttendance +
          thirteenth.thirteenth_month_payout_php,
      );

      // 5k. §6.7 statutory.
      const statutory = await computeStatutory(
        admin,
        Number(empl.monthly_salary_credit_php),
        period.period_end,
      );

      // 5l. §6.8 WT — taxable = gross − (sss_ee + phil_ee + pag_ee) − (non-taxable allowance per day × days_present).
      const statutoryEeSum = round2(
        statutory.sss_ee_php +
          statutory.philhealth_ee_php +
          statutory.pagibig_ee_php,
      );
      const nonTaxableAllowanceTotal = round2(
        earnings.non_taxable_allowance_per_day * counts.days_present,
      );
      const taxable = round2(
        gross_pay_php - statutoryEeSum - nonTaxableAllowanceTotal,
      );
      const wt_compensation_php = await computeWt(
        admin,
        taxable,
        period.period_end,
      );

      // 5m. §6.9 staff advance settlement.
      const staff_advance_settlement_php = await computeStaffAdvanceSettlement(
        admin,
        empl.staff_profile_id,
        gross_pay_php,
        statutoryEeSum,
        wt_compensation_php,
        tardiness.tardiness_deduction_php,
        settings.staff_advance_settlement_max_pct,
      );

      // 5n. §6.10 loan amortization + manual deduction lines.
      const loanLines = await recreateLoanAmortizationLines(
        admin,
        er.id,
        er.employee_id,
        period.period_start,
      );
      const { data: manualDed, error: mdErr } = await admin
        .from("payroll_deduction_lines")
        .select("*")
        .eq("employee_run_id", er.id)
        .neq("kind", "loan_amortization")
        .order("created_at", { ascending: true });
      if (mdErr) {
        return { ok: false, error: `Load manual deductions: ${mdErr.message}` };
      }
      const orderedOtherLines = [
        ...loanLines.map((l) => ({ id: l.id, amount_php: Number(l.amount_php) })),
        ...((manualDed ?? []) as DeductionLineRow[]).map((l) => ({
          id: l.id,
          amount_php: Number(l.amount_php),
        })),
      ];

      // 5o. §6.11 apply cap in priority order.
      const capped = applyDeductionCap(
        gross_pay_php,
        statutoryEeSum,
        wt_compensation_php,
        tardiness.tardiness_deduction_php,
        staff_advance_settlement_php,
        orderedOtherLines,
      );

      // 5p. Write back capped amounts to any deduction line whose amount changed.
      for (let i = 0; i < orderedOtherLines.length; i++) {
        const before = orderedOtherLines[i].amount_php;
        const after = capped.capped_lines[i].amount_php;
        if (round2(before) !== round2(after)) {
          const { error: updErr } = await admin
            .from("payroll_deduction_lines")
            .update({ amount_php: round2(after) })
            .eq("id", orderedOtherLines[i].id);
          if (updErr) {
            return {
              ok: false,
              error: `Cap-write deduction line ${orderedOtherLines[i].id}: ${updErr.message}`,
            };
          }
        }
      }

      // 5q. §6.12 write all summary columns to payroll_employee_runs.
      const update: Database["public"]["Tables"]["payroll_employee_runs"]["Update"] =
        {
          scheduled_days: counts.scheduled_days,
          days_present: counts.days_present,
          days_unpaid_absent: counts.days_unpaid_absent,
          days_vl_used: counts.days_vl_used,
          days_sl_used: counts.days_sl_used,
          days_regular_holiday_worked: counts.days_regular_holiday_worked,
          days_regular_holiday_unworked: counts.days_regular_holiday_unworked,
          days_special_holiday_worked: counts.days_special_holiday_worked,
          days_special_holiday_unworked: counts.days_special_holiday_unworked,
          minutes_late_total: tardiness.minutes_late_total,
          tardiness_count: tardiness.tardiness_count,
          missing_punch_days: earnings.missing_punch_days,
          ot_overage_unpaid_minutes_total:
            earnings.ot_overage_unpaid_minutes_total,
          basic_pay_php: round2(earnings.basic_pay_php),
          allowances_total_php: round2(earnings.allowances_total_php),
          ot_pay_php: round2(earnings.ot_pay_php),
          night_diff_pay_php: round2(earnings.night_diff_pay_php),
          holiday_pay_php: round2(earnings.holiday_pay_php),
          incentives_total_php: round2(earnings.incentives_total_php),
          perfect_attendance_bonus_php: round2(perfectAttendance),
          thirteenth_month_accrual_php: round2(
            thirteenth.thirteenth_month_accrual_php,
          ),
          thirteenth_month_payout_php: round2(
            thirteenth.thirteenth_month_payout_php,
          ),
          gross_pay_php: round2(gross_pay_php),
          sss_ee_php: round2(statutory.sss_ee_php),
          sss_er_php: round2(statutory.sss_er_php),
          philhealth_ee_php: round2(statutory.philhealth_ee_php),
          philhealth_er_php: round2(statutory.philhealth_er_php),
          pagibig_ee_php: round2(statutory.pagibig_ee_php),
          pagibig_er_php: round2(statutory.pagibig_er_php),
          wt_compensation_php: round2(capped.wt_capped),
          tardiness_deduction_php: round2(capped.tardiness_capped),
          staff_advance_settlement_php: round2(capped.advance_capped),
          other_deductions_total_php: round2(capped.other_total_capped),
          net_pay_php: round2(capped.net_pay_php),
        };
      const { error: updErr } = await admin
        .from("payroll_employee_runs")
        .update(update)
        .eq("id", er.id);
      if (updErr) {
        return {
          ok: false,
          error: `Write employee_run ${er.id}: ${updErr.message}`,
        };
      }
      updatedCount += 1;
    }

    // 6. Flip the run status.
    try {
      await flipRunToComputed(admin, runId);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    return { ok: true, updated: updatedCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function flipRunToComputed(
  admin: SupabaseClient<Database>,
  runId: string,
): Promise<void> {
  const { error } = await admin
    .from("payroll_runs")
    .update({ status: "computed", computed_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new Error(`Flip status: ${error.message}`);
}
