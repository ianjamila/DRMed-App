"use client";

import { useMemo, useState } from "react";
import {
  dayWindowFor,
  minutesOfDay,
  type PhysicianAvailability,
} from "@/lib/physicians/availability";

export interface ClosureLite {
  closed_on: string; // YYYY-MM-DD, Asia/Manila
  reason: string;
}

interface Props {
  // ISO date (YYYY-MM-DD) of "tomorrow in Manila", computed server-side so
  // the day grid doesn't depend on the visitor's local clock.
  startDate: string;
  // Same shape, 60 days after startDate inclusive.
  closures: ClosureLite[];
  required?: boolean;
  // When provided, restrict bookable days/times to the given physician's
  // recurring schedule and overrides.
  availability?: PhysicianAvailability | null;
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
  // Use UTC arithmetic on a midnight-anchored Date so we don't drift across
  // DST boundaries on the visitor's clock. PH has no DST, but the visitor
  // might be elsewhere.
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

export function SlotPicker({
  startDate,
  closures,
  required = true,
  availability = null,
}: Props) {
  const days = useMemo(() => buildDays(startDate, closures), [startDate, closures]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);

  // Resolve per-day availability once per render. When availability is null,
  // every day shows the default 8:00–16:30 grid.
  const dayAvailability = useMemo(() => {
    return new Map(
      days.map((d) => [
        d.date,
        dayWindowFor(d.date, d.dayOfWeek, availability),
      ]),
    );
  }, [days, availability]);

  const scheduledAt =
    selectedDate && selectedTime
      ? `${selectedDate}T${selectedTime}:00+08:00`
      : "";

  // Group days into months for headers.
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
    <div className="grid gap-4">
      <input
        type="hidden"
        name="scheduled_at"
        value={scheduledAt}
        required={required}
      />

      <div>
        <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          Pick a day
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Mon–Sat only. Closed days are dimmed and not selectable.
        </p>
        <div className="mt-3 grid gap-4">
          {monthGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
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
                    "flex flex-col items-center rounded-md border px-2 py-2 text-xs transition";
                  let stateClass = "";
                  if (disabled) {
                    stateClass =
                      "cursor-not-allowed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)] opacity-60";
                  } else if (isSelected) {
                    stateClass =
                      "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white shadow";
                  } else {
                    stateClass =
                      "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-bg)]";
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
                      onClick={() => {
                        setSelectedDate(day.date);
                        setSelectedTime(null);
                      }}
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
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          30-minute slots, 8:00 AM – 4:30 PM. Last appointment finishes by 5
          PM.
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
              // Inclusive on start, exclusive on end so a 12:00 end window
              // hides the 12:00 slot (last bookable is 11:30).
              return m >= startMin && m < endMin;
            });
            if (visibleTimes.length === 0) {
              return (
                <p className="mt-3 rounded-md border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-3 py-4 text-xs text-[color:var(--color-brand-text-soft)]">
                  No times available on this day.
                </p>
              );
            }
            return (
              <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-9">
                {visibleTimes.map((t) => {
                  const isSelected = t === selectedTime;
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedTime(t)}
                      className={`rounded-md border px-2 py-1.5 text-xs font-semibold transition ${
                        isSelected
                          ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                          : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-bg)]"
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
          <p className="mt-3 rounded-md border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-3 py-4 text-xs text-[color:var(--color-brand-text-soft)]">
            Pick a day first.
          </p>
        )}
      </div>

      {selectedDay && selectedTime ? (
        <p className="text-sm text-[color:var(--color-brand-text-mid)]">
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
