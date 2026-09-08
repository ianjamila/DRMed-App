/**
 * Human-readable labels for `appointments.status`.
 *
 * The DB CHECK constraint (0019_schedule_rework_schema.sql) only ever admits
 * these six values, but `database.ts` types the column as a plain `string`
 * (not a union), so any caller reading a row off the wire is handing us an
 * untyped string. `appointmentStatusLabel` narrows defensively and falls
 * back to the old `replace(/_/g, " ")` behaviour for a value outside the six
 * — never renders `undefined` — so a future status added to the DB without
 * updating this map still shows *something* instead of breaking the page.
 */

export const APPOINTMENT_STATUSES = [
  "pending_callback",
  "confirmed",
  "arrived",
  "cancelled",
  "no_show",
  "completed",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending_callback: "Pending callback",
  confirmed: "Confirmed",
  arrived: "Arrived",
  cancelled: "Cancelled",
  no_show: "No show",
  completed: "Completed",
};

function isAppointmentStatus(value: string): value is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Look up the display label for a status value of unknown provenance
 * (`appointments.status` is typed as `string`, not the union above).
 * Falls back to the raw underscore-to-space rendering the callers used
 * before this map existed, so an unrecognised value degrades gracefully
 * instead of showing `undefined`.
 */
export function appointmentStatusLabel(status: string): string {
  return isAppointmentStatus(status)
    ? APPOINTMENT_STATUS_LABEL[status]
    : status.replace(/_/g, " ");
}
