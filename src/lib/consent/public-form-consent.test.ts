import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_FORM_CONSENT, publicFormConsentStatement } from "./public-form-consent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("public-form consent wording", () => {
  it("backfilled existing grants with exactly the statements the forms show", () => {
    // 0162 wrote these literals onto the grants recorded before the column
    // existed. If a form's wording changes, that is fine for NEW grants (they
    // store their own text) — but 0162 must never be edited to match.
    const migration = read("supabase/migrations/0162_consent_list_and_record_fidelity.sql");
    for (const form of ["register", "schedule"] as const) {
      expect(migration).toContain(`'${publicFormConsentStatement(form)}'`);
    }
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
