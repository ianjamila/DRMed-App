import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { friendlyManilaDate } from "@/lib/dates/manila";

/** Links shown before the rest fold into "and N more". */
const MAX_LINKS = 5;

/**
 * "Earlier days not closed" — shown on Cash In & Out, End of Day and the
 * reception + admin dashboards (`EodReminderBanner`) once Admin
 * has set a reminders start date (Money Routing). Each day links straight to
 * its End of Day screen on the same shift. Renders nothing when every day is
 * closed, and nothing while the reminders are off (the list is empty then).
 */
export function UnclosedDaysNotice({
  days,
  shiftId,
  className,
}: {
  days: string[];
  shiftId: string;
  className?: string;
}) {
  if (days.length === 0) return null;
  // Most recent first: yesterday is the one reception can still remember.
  const newestFirst = [...days].sort().reverse();
  const shown = newestFirst.slice(0, MAX_LINKS);
  const more = newestFirst.length - shown.length;
  const oldest = newestFirst[newestFirst.length - 1]!;

  return (
    <Alert variant="warning" className={className}>
      <AlertTitle>
        {days.length === 1
          ? "An earlier day was not closed"
          : `${days.length} earlier days were not closed`}
      </AlertTitle>
      <AlertDescription>
        <p>Cash moved through the drawer on these days, but nobody counted and closed it.</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {shown.map((day) => (
            <li key={day}>
              <Link
                href={`/staff/payments/eod?date=${day}&shift=${shiftId}`}
                className="inline-flex min-h-[44px] items-center rounded border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                Close {friendlyManilaDate(day)}
              </Link>
            </li>
          ))}
          {more > 0 && (
            <li>
              <Link
                href={`/staff/payments/eod?date=${oldest}&shift=${shiftId}`}
                className="inline-flex min-h-[44px] items-center px-1 text-sm underline"
              >
                and {more} more — oldest first
              </Link>
            </li>
          )}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
