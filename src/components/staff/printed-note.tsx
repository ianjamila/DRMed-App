import type { PrintSummary } from "@/lib/results/print-summary";
import { manilaDateTime, manilaISODate, manilaTime, todayManilaISODate } from "@/lib/dates/manila";

// "Printed 10:42 AM by Ana Cruz · 2 times" under a Print result button, so
// the counter sees a copy already went out. Today's prints show the time
// alone; older ones carry the date.
export function PrintedNote({
  summary,
  size = "default",
}: {
  summary: PrintSummary | undefined;
  size?: "default" | "compact";
}) {
  if (!summary) return null;
  const when =
    manilaISODate(summary.lastAt) === todayManilaISODate()
      ? manilaTime(summary.lastAt)
      : manilaDateTime(summary.lastAt);
  const text = size === "compact" ? "text-[10px]" : "text-xs";
  return (
    <span className={`${text} max-w-56 text-right text-[color:var(--color-brand-text-soft)]`}>
      Printed {when}
      {summary.lastBy ? ` by ${summary.lastBy}` : ""}
      {summary.count > 1 ? ` · ${summary.count} times` : ""}
    </span>
  );
}
