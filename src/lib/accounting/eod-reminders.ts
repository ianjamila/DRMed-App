import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * End of Day reminders (0185). The owner sets `eod_reminders_start_date` on
 * Money Routing; until then it is blank and nothing is ever flagged. Which days
 * count — moved cash through the drawer, never closed, on or after the start
 * date, before today — is decided in SQL (`eod_unclosed_days`) from
 * `cash_drawer_state` itself, so a flagged day always opens to an End of Day
 * screen with something to count.
 */
export const EOD_REMINDERS_START_KEY = "eod_reminders_start_date";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Unclosed days for one shift, oldest first. `from` / `to` default to the
 * start date and yesterday; the function clamps both anyway.
 *
 * A reminder is a nudge, not a gate: when the read fails this returns no days
 * rather than taking the till screen down with it. The admin report, which
 * must not quietly show "all closed", passes `throwOnError`.
 */
export async function loadUnclosedEodDays(
  admin: AdminClient,
  shiftId: string,
  opts: { from?: string; to?: string; throwOnError?: boolean } = {},
): Promise<string[]> {
  const { data, error } = await admin.rpc("eod_unclosed_days", {
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
    p_shift_id: shiftId,
  });
  if (error) {
    if (opts.throwOnError) throw new Error(error.message);
    console.error("[eod-reminders] eod_unclosed_days failed:", error.message);
    return [];
  }
  return [...((data as string[] | null) ?? [])].sort();
}

/**
 * Every active shift's unclosed days in [from, to], as day → shift ids. For
 * the Cash & cards report and its CSV, which describe the day across shifts.
 * Throws on a failed read: a report must not quietly show "nothing missing".
 */
export async function loadUnclosedEodDaysByDay(
  admin: AdminClient,
  from: string,
  to: string,
): Promise<Map<string, string[]>> {
  const { data: shifts, error } = await admin
    .from("cash_shifts")
    .select("id")
    .eq("is_active", true)
    .order("sort_order");
  if (error) throw new Error(error.message);

  const perShift = await Promise.all(
    (shifts ?? []).map(async (sh) => ({
      shiftId: sh.id,
      days: await loadUnclosedEodDays(admin, sh.id, { from, to, throwOnError: true }),
    })),
  );
  const byDay = new Map<string, string[]>();
  for (const { shiftId, days } of perShift) {
    for (const day of days) byDay.set(day, [...(byDay.get(day) ?? []), shiftId]);
  }
  return byDay;
}
