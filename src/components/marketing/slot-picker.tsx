"use client";

import { useMemo } from "react";
import {
  dayWindowFor,
  minutesOfDay,
  type PhysicianAvailability,
} from "@/lib/physicians/availability";

export interface ClosureLite {
  closed_on: string; // YYYY-MM-DD, Asia/Manila
  reason: string;
}

export interface SlotValue {
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
}

interface Props {
  // ISO date (YYYY-MM-DD) of "tomorrow in Manila", computed server-side so
  // the day grid doesn't depend on the visitor's local clock.
  startDate: string;
  // Same shape, 60 days after startDate inclusive.
  closures: ClosureLite[];
  // When provided, restrict bookable days/times to the given physician's
  // recurring schedule and overrides.
  availability?: PhysicianAvailability | null;
  // Controlled selection — state lives in the parent so the booking wizard can
  // keep it across step transitions (the parent emits the `scheduled_at` hidden
  // field). The combined `scheduled_at` ISO is derived from value.date+value.time.
  value: SlotValue;
  onChange: (next: SlotValue) => void;
}

interface DayCell {
  date: string; // YYYY-MM-DD
  dayOfWeek: number; // 0=Sun … 6=Sat
  monthLabel: string; // e.g. "May 2026"
  dayNumber: number;
  weekdayShort: string; // e.g. "Mon"
  closure: ClosureLite | null;
  isSunday: boolean;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Build the next 60 days in pure date arithmetic (no Date timezone weirdness).
// startDate is treated as a Manila-local YYYY-MM-DD string.
function buildDays(startDate: string, closures: ClosureLite[]): DayCell[] {
  const closureMap = new Map(closures.map((c) => [c.closed_on, c]));
  const [y, m, d] = startDate.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const out: DayCell[] = [];
  for (let i = 0; i < 60; i++) {
    const yy = cursor.getUTCFullYear();
    const mm = cursor.getUTCMonth();
    const dd = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    const iso = `${yy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    out.push({
      date: iso,
      dayOfWeek: dow,
      monthLabel: `${MONTH_LONG[mm]} ${yy}`,
      dayNumber: dd,
      weekdayShort: WEEKDAY_SHORT[dow],
      closure: closureMap.get(iso) ?? null,
      isSunday: dow === 0,
    });
    cursor.setUTCDate(dd + 1);
  }
  return out;
}

// 30-minute slots from 08:00 to 16:30 inclusive.
function buildTimes(): string[] {
  const out: string[] = [];
  for (let h = 8; h <= 16; h++) {
    out.push(`${String(h).padStart(2, "0")}:00`);
    out.push(`${String(h).padStart(2, "0")}:30`);
  }
  return out;
}

const TIMES = buildTimes();

// Combine a controlled SlotValue into the `scheduled_at` string the server
// expects (or "" when incomplete). Kept here so the wizard and any other caller
// derive it identically.
export function slotScheduledAt(value: SlotValue): string {
  return value.date && value.time
    ? `${value.date}T${value.time}:00+08:00`
    : "";
}

/**
 * Controlled day/time picker restyled as a warm chip grid. Availability/closure
 * logic is unchanged from the original; only presentation + the controlled API
 * differ. The parent owns the selection and emits the hidden `scheduled_at`.
 */
export function SlotPicker({
  startDate,
  closures,
  availability = null,
  value,
  onChange,
}: Props) {
  const days = useMemo(() => buildDays(startDate, closures), [startDate, closures]);

  const dayAvailability = useMemo(() => {
    return new Map(
      days.map((d) => [d.date, dayWindowFor(d.date, d.dayOfWeek, availability)]),
    );
  }, [days, availability]);

  const selectedDate = value.date;
  const selectedTime = value.time;

  const monthGroups: Array<{ label: string; days: DayCell[] }> = [];
  for (const day of days) {
    const last = monthGroups[monthGroups.length - 1];
    if (!last || last.label !== day.monthLabel) {
      monthGroups.push({ label: day.monthLabel, days: [day] });
    } else {
      last.days.push(day);
    }
  }

  const selectedDay = selectedDate
    ? days.find((d) => d.date === selectedDate) ?? null
    : null;

  return (
    <div className="grid gap-5">
      <div>
        <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          Pick a day
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-ink-soft)]">
          Mon–Sat only. Closed days are dimmed and not selectable.
        </p>
        <div className="mt-3 grid gap-4">
          {monthGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                {group.label}
              </p>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-7">
                {group.days.map((day) => {
                  const window = dayAvailability.get(day.date);
                  const physicianClosed =
                    availability !== null && window?.available === false;
                  const disabled =
                    day.isSunday || day.closure !== null || physicianClosed;
                  const isSelected = day.date === selectedDate;
                  const baseClass =
                    "flex flex-col items-center rounded-[14px] border px-2 py-2 text-xs transition";
                  let stateClass = "";
                  if (disabled) {
                    stateClass =
                      "cursor-not-allowed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] text-[color:var(--color-ink-soft)] opacity-60";
                  } else if (isSelected) {
                    stateClass =
                      "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white shadow-[var(--shadow-warm-sm)]";
                  } else {
                    stateClass =
                      "border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-ink-mid)] hover:border-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-warm-sand)]";
                  }
                  const title = day.closure
                    ? `Closed — ${day.closure.reason}`
                    : day.isSunday
                      ? "Closed on Sundays"
                      : physicianClosed
                        ? window?.reason === "full_day_override"
                          ? "Doctor unavailable this day"
                          : "Doctor not scheduled this day"
                        : undefined;
                  return (
                    <button
                      key={day.date}
                      type="button"
                      disabled={disabled}
                      title={title}
                      aria-pressed={isSelected}
                      onClick={() => onChange({ date: day.date, time: null })}
                      className={`${baseClass} ${stateClass}`}
                    >
                      <span className="text-[10px] font-bold uppercase tracking-wider">
                        {day.weekdayShort}
                      </span>
                      <span className="mt-0.5 text-base font-extrabold">
                        {day.dayNumber}
                      </span>
                      {day.closure ? (
                        <span className="mt-0.5 text-[9px] font-semibold uppercase">
                          Closed
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          Pick a time
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-ink-soft)]">
          30-minute slots, 8:00 AM – 4:30 PM. Last appointment finishes by 5 PM.
        </p>
        {selectedDate ? (
          (() => {
            const window = dayAvailability.get(selectedDate);
            const startMin = window?.start_time
              ? minutesOfDay(window.start_time)
              : 8 * 60;
            const endMin = window?.end_time
              ? minutesOfDay(window.end_time)
              : 16 * 60 + 30;
            const visibleTimes = TIMES.filter((t) => {
              const m = minutesOfDay(t);
              return m >= startMin && m < endMin;
            });
            if (visibleTimes.length === 0) {
              return (
                <p className="mt-3 rounded-[12px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] px-3 py-4 text-xs text-[color:var(--color-ink-soft)]">
                  No times available on this day.
                </p>
              );
            }
            return (
              <div className="mt-3 flex flex-wrap gap-2">
                {visibleTimes.map((t) => {
                  const isSelected = t === selectedTime;
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onChange({ date: selectedDate, time: t })}
                      className={`min-h-[44px] rounded-full border px-4 py-2 text-[13.5px] font-semibold transition ${
                        isSelected
                          ? "border-[color:var(--color-brand-cyan)] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-navy)]"
                          : "border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-ink-mid)] hover:border-[color:var(--color-brand-cyan)]"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            );
          })()
        ) : (
          <p className="mt-3 rounded-[12px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] px-3 py-4 text-xs text-[color:var(--color-ink-soft)]">
            Pick a day first.
          </p>
        )}
      </div>

      {selectedDay && selectedTime ? (
        <p className="text-sm text-[color:var(--color-ink-mid)]">
          Selected:{" "}
          <span className="font-bold text-[color:var(--color-brand-navy)]">
            {selectedDay.weekdayShort}, {selectedDay.monthLabel.split(" ")[0]}{" "}
            {selectedDay.dayNumber} · {selectedTime}
          </span>
        </p>
      ) : null}
    </div>
  );
}
