/**
 * How long an appointment with no set time has been sitting open, and when
 * reception should treat it as a likely no-show.
 *
 * Bookings with `scheduled_at = null` (diagnostic packages, untimed lab
 * requests — every public lab-request booking) stay on the Appointments page
 * until someone marks them arrived, no-show or cancelled. Nothing closes them
 * automatically, so a booking the patient never turned up for sits there
 * indefinitely (29 of them on prod on 2026-09-25, the oldest from June, none
 * with a visit since). This module is the one definition of "old enough to be
 * a likely no-show", shared by the page's badge, the bulk action's button and
 * the server action's database predicate so the three can't disagree.
 *
 * Pure — no `server-only`, no DB — so it is vitest-tested directly.
 */

import { z } from "zod";
import { manilaISODate, shiftISODate } from "@/lib/dates/manila";

/** A booking this many Manila calendar days old (or older) is a likely no-show. */
export const STALE_UNTIMED_AFTER_DAYS = 7;

/**
 * Whole Manila calendar days between the day `createdAt` fell on and
 * `todayIso` — 0 for a booking made today, 1 for yesterday. Counted on
 * calendar dates (never a `Date` in the runtime's zone), so a booking made at
 * 23:50 Manila is "1 day" old ten minutes later, the way reception reads it.
 */
export function bookingAgeDays(createdAt: string, todayIso: string): number {
  const createdIso = manilaISODate(createdAt);
  if (!createdIso) return 0;
  const diff =
    (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${createdIso}T00:00:00Z`)) / 86_400_000;
  return Math.max(0, Math.round(diff));
}

/** "Booked today" / "Booked yesterday" / "Booked 12 days ago". */
export function bookingAgeLabel(days: number): string {
  if (days <= 0) return "Booked today";
  if (days === 1) return "Booked yesterday";
  return `Booked ${days} days ago`;
}

export interface StaleCandidate {
  status: string;
  scheduled_at: string | null;
  created_at: string;
}

/**
 * A likely no-show: still `confirmed` (never marked arrived), no set time, and
 * at least `STALE_UNTIMED_AFTER_DAYS` Manila days old. `arrived` is never
 * stale — that patient is physically here — and a timed booking has its own
 * date to judge it by.
 */
export function isStaleUntimedBooking(row: StaleCandidate, todayIso: string): boolean {
  return (
    row.status === "confirmed" &&
    row.scheduled_at === null &&
    bookingAgeDays(row.created_at, todayIso) >= STALE_UNTIMED_AFTER_DAYS
  );
}

/**
 * The same rule as a `created_at` bound for the database: a row is stale
 * exactly when `created_at < staleCutoffIso(todayIso)` — Manila midnight
 * starting the day `STALE_UNTIMED_AFTER_DAYS - 1` days before today.
 * (Age ≥ N  ⇔  created on or before today−N  ⇔  created before today−(N−1).)
 */
export function staleCutoffIso(todayIso: string): string {
  const firstNonStaleDay = shiftISODate(todayIso, -(STALE_UNTIMED_AFTER_DAYS - 1));
  return new Date(`${firstNonStaleDay}T00:00:00+08:00`).toISOString();
}

/**
 * Input to the bulk "Mark as no-show" action and its Undo: the bookings the
 * page showed, one inner array of appointment ids per booking (a
 * multi-service booking is several rows sharing a `booking_group_id`). The
 * page can't send more than it rendered, but a "use server" export is
 * callable with anything, so the shape and size are checked here.
 */
export const BULK_NO_SHOW_MAX_BOOKINGS = 500;
export const BulkBookingIdsSchema = z
  .array(z.array(z.string().uuid()).min(1).max(50))
  .min(1)
  .max(BULK_NO_SHOW_MAX_BOOKINGS);
export type BulkBookingIds = z.infer<typeof BulkBookingIdsSchema>;

/**
 * Splits bookings for the bulk Undo into those that may go back to confirmed
 * and those that must stay no-show. A booking comes back only when every row
 * is a walk-in (no patient) or belongs to an ACTIVE patient — the same rule
 * the single ↶ Revert enforces, applied per booking so one merged or deleted
 * record doesn't block the whole Undo. A row whose patient is unknown to
 * `patientOf` (it vanished between mark and undo) holds its booking back.
 */
export function splitBookingsByActivePatient(
  bookings: readonly (readonly string[])[],
  patientOf: ReadonlyMap<string, string | null>,
  activePatientIds: ReadonlySet<string>,
): { restorable: string[][]; heldBack: string[][] } {
  const restorable: string[][] = [];
  const heldBack: string[][] = [];
  for (const ids of bookings) {
    const ok = ids.every((id) => {
      if (!patientOf.has(id)) return false;
      const pid = patientOf.get(id) ?? null;
      return pid === null || activePatientIds.has(pid);
    });
    (ok ? restorable : heldBack).push([...ids]);
  }
  return { restorable, heldBack };
}

/**
 * A booking with no set time that nobody has acted on (still `confirmed`) for
 * this many Manila days is worth a reminder email — earlier than the
 * likely-no-show mark, so reception can still call the patient.
 */
export const REMIND_UNTIMED_AFTER_DAYS = 3;

export interface BookingRow {
  id: string;
  booking_group_id: string | null;
}

/**
 * One entry per booking — a multi-service booking is several rows sharing a
 * `booking_group_id` — in first-seen order, each group's rows in input order.
 * Pass rows oldest-first (the Appointments page's order) so the lead row,
 * `group[0]`, is the one the page judges the booking by.
 */
export function groupBookingRows<T extends BookingRow>(rows: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.booking_group_id ?? row.id;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/**
 * How many bookings the Appointments page would tag "Likely no-show": rows
 * with no set time (confirmed or arrived), oldest-first, grouped by booking
 * and judged by the lead row — the dashboard count and the page's bar agree.
 */
export function countLikelyNoShowBookings(
  rows: readonly (BookingRow & StaleCandidate)[],
  todayIso: string,
): number {
  return groupBookingRows(rows).filter((g) => isStaleUntimedBooking(g[0], todayIso)).length;
}

/**
 * Bookings nobody has acted on for at least `minDays` Manila days — the
 * reminder email's list. Takes the same oldest-first open rows as the page
 * (confirmed + arrived, no set time), groups them by booking, and keeps a
 * booking whose lead row is still `confirmed` (an arrived patient has been
 * acted on). Oldest first.
 */
export function unactedBookings<T extends BookingRow & StaleCandidate>(
  rows: readonly T[],
  todayIso: string,
  minDays: number = REMIND_UNTIMED_AFTER_DAYS,
): { rows: T[]; ageDays: number; likelyNoShow: boolean }[] {
  return groupBookingRows(rows)
    .filter((g) => g[0].status === "confirmed" && g[0].scheduled_at === null)
    .map((g) => ({
      rows: g,
      ageDays: bookingAgeDays(g[0].created_at, todayIso),
      likelyNoShow: isStaleUntimedBooking(g[0], todayIso),
    }))
    .filter((b) => b.ageDays >= minDays);
}
