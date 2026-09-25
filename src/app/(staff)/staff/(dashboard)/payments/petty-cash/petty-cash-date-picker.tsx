"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { friendlyManilaDate } from "@/lib/dates/manila";
import { ResetSafeSelect } from "@/components/forms/stable-fields";

interface Shift {
  id: string;
  code: string;
  label: string;
}

/**
 * Day (and, with more than one active shift, shift) picker for the
 * petty-cash page, mirroring the cash-drawer page's date-input +
 * router.push approach (`payments/cash-drawer/cash-drawer-client.tsx`) so
 * the two pages feel identical and switching shift here keeps the round
 * trip drawer -> petty cash -> drawer on the same shift.
 */
export function PettyCashDatePicker({
  date,
  today,
  shifts,
  currentShiftId,
}: {
  date: string;
  today: string;
  shifts: Shift[];
  currentShiftId: string;
}) {
  const router = useRouter();
  const isToday = date === today;

  const navigate = (nextDate: string, nextShiftId: string) =>
    router.push(`/staff/payments/petty-cash?date=${nextDate}&shift=${nextShiftId}`);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
      <span className="font-medium text-[color:var(--color-brand-navy)]">
        {friendlyManilaDate(date)}
      </span>
      <input
        type="date"
        value={date}
        max={today}
        onChange={(e) => navigate(e.target.value, currentShiftId)}
        className="rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1"
      />
      {shifts.length > 1 && (
        <ResetSafeSelect
          value={currentShiftId}
          onChange={(e) => navigate(date, e.target.value)}
          aria-label="Shift"
          className="rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1"
        >
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </ResetSafeSelect>
      )}
      {!isToday && (
        <Link
          href={`/staff/payments/petty-cash?shift=${currentShiftId}`}
          className="rounded border border-[color:var(--color-brand-navy)] px-3 py-1 font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Back to today
        </Link>
      )}
    </div>
  );
}
