// Pure wording for the walk-in (no scheduled time) booking confirmation, split
// out of notify-appointment-booked.ts (server-only) so it is unit-testable.
// Hours come from the one source of truth (site.ts via nap.ts) — never a
// hardcoded copy. A walk-in lab booking can be done Sunday morning too, so the
// Sunday lab-only hours ride along; a booked slot (a specific time) does not.

import { CONTACT } from "@/lib/marketing/site";
import { hoursSundayLabel, hoursSundayShort } from "@/lib/marketing/nap";

/** "Walk in any time — Monday – Saturday, 8:00 AM – 5:00 PM". */
export function walkInWhenLine(): string {
  return `Walk in any time — ${CONTACT.hours}`;
}

/** Second detail row / plain-text line under the walk-in "Date / time". */
export function walkInAlsoOpen(): { label: string; value: string } {
  return { label: "Also open", value: hoursSundayLabel() };
}

/** Walk-in confirmation SMS. Sunday goes in short form ("Sun 8am–12nn lab only"). */
export function walkInSmsBody(input: {
  greeting: string;
  serviceName: string;
  cancelUrl: string;
}): string {
  return (
    `Hi ${input.greeting}, your DRMed booking for ${input.serviceName} is confirmed. ` +
    `Walk in any time — ${CONTACT.hours}; ${hoursSundayShort()}. ` +
    `Cancel: ${input.cancelUrl} — DRMED`
  );
}
