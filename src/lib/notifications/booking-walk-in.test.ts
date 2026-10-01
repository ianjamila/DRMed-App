import { describe, expect, it } from "vitest";
import { CONTACT } from "@/lib/marketing/site";
import { smsSegmentCount } from "@/lib/contact-messages/reply-content";
import { walkInAlsoOpen, walkInSmsBody, walkInWhenLine } from "./booking-walk-in";

const INPUT = {
  greeting: "Maria",
  serviceName: "Complete Blood Count (CBC)",
  cancelUrl: "https://drmed.ph/appointments/cancel/123e4567-e89b-12d3-a456-426614174000",
};

// The walk-in text exactly as it read before Sunday hours were added.
function before(i: typeof INPUT): string {
  return (
    `Hi ${i.greeting}, your DRMed booking for ${i.serviceName} is confirmed. Walk in any time — ${CONTACT.hours}. ` +
    `Cancel: ${i.cancelUrl} — DRMED`
  );
}

describe("walk-in booking confirmation wording", () => {
  it("SMS keeps the Mon–Sat hours and adds the short Sunday lab-only line", () => {
    const sms = walkInSmsBody(INPUT);
    expect(sms).toContain(`Walk in any time — ${CONTACT.hours}; Sun 8am–12nn lab only.`);
    expect(sms).toContain(INPUT.cancelUrl);
    expect(sms.endsWith("— DRMED")).toBe(true);
  });

  it("SMS addition is only the short Sunday clause, and the cancel link is never dropped", () => {
    const delta = walkInSmsBody(INPUT).length - before(INPUT).length;
    expect(delta).toBe("; Sun 8am–12nn lab only".length);
    // Already past one 160-char segment before the change (the link alone is 78
    // chars); the addition must not tip it into a further segment for the usual
    // service names.
    expect(smsSegmentCount(walkInSmsBody(INPUT))).toBe(smsSegmentCount(before(INPUT)));
  });

  it("email wording: Mon–Sat in the Date / time row, Sunday lab hours as an 'Also open' row", () => {
    expect(walkInWhenLine()).toBe(`Walk in any time — ${CONTACT.hours}`);
    expect(walkInAlsoOpen()).toEqual({ label: "Also open", value: CONTACT.hoursSunday });
  });
});
