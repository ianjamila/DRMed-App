"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { friendlyManilaDate } from "@/lib/dates/manila";

/**
 * Day picker for the petty-cash page, mirroring the cash-drawer page's
 * date-input + router.push approach (`payments/cash-drawer/cash-drawer-client.tsx`)
 * so the two pages feel identical.
 */
export function PettyCashDatePicker({
  date,
  today,
}: {
  date: string;
  today: string;
}) {
  const router = useRouter();
  const isToday = date === today;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
      <span className="font-medium text-[color:var(--color-brand-navy)]">
        {friendlyManilaDate(date)}
      </span>
      <input
        type="date"
        value={date}
        max={today}
        onChange={(e) =>
          router.push(`/staff/payments/petty-cash?date=${e.target.value}`)
        }
        className="rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1"
      />
      {!isToday && (
        <Link
          href="/staff/payments/petty-cash"
          className="rounded border border-[color:var(--color-brand-navy)] px-3 py-1 font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Back to today
        </Link>
      )}
    </div>
  );
}
