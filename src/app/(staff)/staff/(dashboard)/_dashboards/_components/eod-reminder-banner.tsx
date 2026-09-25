import { createAdminClient } from "@/lib/supabase/admin";
import { loadUnclosedEodDays } from "@/lib/accounting/eod-reminders";
import { UnclosedDaysNotice } from "@/components/staff/unclosed-days-notice";

/**
 * The End of Day "not closed" nudge on the reception and admin dashboards —
 * the two roles that can close a day. Same list, same links as Cash In & Out
 * and End of Day, so a missed close is visible the moment staff sign in, not
 * only once someone opens the till screens.
 *
 * Reads the first active shift, like the dashboard's Cash drawer card and the
 * Cash Drawer page do. Renders nothing while Admin has not set a reminders
 * start date (Money Routing), when every day is closed, and when the read
 * fails: it is a nudge, not a card, so there is no "couldn't load" state to
 * show and it is deliberately not hideable in the card preferences — it only
 * appears when there is something to do.
 */
export async function EodReminderBanner() {
  const admin = createAdminClient();
  const { data: shift, error } = await admin
    .from("cash_shifts")
    .select("id")
    .eq("is_active", true)
    .order("sort_order")
    .limit(1)
    .maybeSingle();
  if (error || !shift) return null;

  const days = await loadUnclosedEodDays(admin, shift.id);
  return <UnclosedDaysNotice days={days} shiftId={shift.id} className="mb-6" />;
}
