// Website Messages — which status a staff member may move a message to,
// from each status. ONE table for the detail page's buttons
// (messages/[id]/message-actions.tsx), the inbox bulk bar and the bulk server
// action (spec 2026-09-25 §7), so the three can never drift. `booked` is set
// only by the booking flow (linkMessageToBooking), never by a staff button.
import { isContactMessageStatus, type ContactMessageStatus } from "./labels";

export const STAFF_STATUS_TARGETS = ["new", "replied", "closed"] as const;
export type StaffStatusTarget = (typeof STAFF_STATUS_TARGETS)[number];

/** Button order is the order here (the detail page renders it as-is). */
export const STATUS_TRANSITIONS: Readonly<Record<ContactMessageStatus, readonly StaffStatusTarget[]>> = {
  new: ["replied", "closed"],
  replied: ["closed", "new"],
  booked: ["closed", "new"],
  closed: ["new"],
};

export function transitionTargets(from: string): readonly StaffStatusTarget[] {
  return isContactMessageStatus(from) ? STATUS_TRANSITIONS[from] : [];
}

export function canTransition(from: string, to: StaffStatusTarget): boolean {
  return transitionTargets(from).includes(to);
}
