import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_BOOKING_CONTACT_ONLY_STATEMENT,
  PUBLIC_FORM_CONSENT,
  publicFormConsentStatement,
} from "./public-form-consent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("public-form consent wording", () => {
  const migration = read("supabase/migrations/0162_consent_list_and_record_fidelity.sql");

  it("backfilled existing grants with exactly the statements those patients saw", () => {
    // 0162 wrote these literals onto the grants recorded before the column
    // existed: the registration wording (unchanged) and the OLD booking
    // wording. New grants store their own text; 0162 must never be edited.
    expect(migration).toContain(`'${publicFormConsentStatement("register")}'`);
    expect(migration).toContain(`'${LEGACY_BOOKING_CONTACT_ONLY_STATEMENT}'`);
  });

  it("asks booking patients for the same consent as registration", () => {
    expect(PUBLIC_FORM_CONSENT.schedule.body.startsWith(PUBLIC_FORM_CONSENT.register.body)).toBe(true);
    expect(publicFormConsentStatement("schedule")).not.toBe(LEGACY_BOOKING_CONTACT_ONLY_STATEMENT);
  });

  it("is what both public forms render", () => {
    expect(read("src/app/(marketing)/register/register-form.tsx")).toContain("PUBLIC_FORM_CONSENT.register.body");
    const booking = read("src/app/(marketing)/schedule/booking-form.tsx");
    expect(booking).toContain("PUBLIC_FORM_CONSENT.schedule.lead");
    expect(booking).toContain("PUBLIC_FORM_CONSENT.schedule.body");
  });

  it("builds the stored statement from lead, body and the Privacy Notice pointer", () => {
    expect(publicFormConsentStatement("schedule")).toBe(
      `${PUBLIC_FORM_CONSENT.schedule.lead} ${PUBLIC_FORM_CONSENT.schedule.body} See the Privacy Notice.`,
    );
    expect(publicFormConsentStatement("register")).toBe(`${PUBLIC_FORM_CONSENT.register.body} See the Privacy Notice.`);
  });
});
