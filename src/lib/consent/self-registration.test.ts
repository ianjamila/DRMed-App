import { describe, expect, it } from "vitest";
import { CURRENT_CONSENT_NOTICE_VERSION } from "./notice";
import {
  selfRegistrationGrant,
  shouldRecordBookingConsent,
} from "./self-registration";

describe("shouldRecordBookingConsent", () => {
  it("records for a brand-new patient who ticked the agreement", () => {
    expect(shouldRecordBookingConsent("created", true)).toBe(true);
  });

  it.each(["reused", "existing", "walk_in"] as const)(
    "never re-affirms consent for a %s patient from a public form",
    (resolution) => {
      expect(shouldRecordBookingConsent(resolution, true)).toBe(false);
    },
  );

  it("never records without the tick, even for a new patient", () => {
    expect(shouldRecordBookingConsent("created", false)).toBe(false);
  });
});

describe("selfRegistrationGrant", () => {
  const row = selfRegistrationGrant({
    patientId: "p-1",
    ip: "203.0.113.9",
    userAgent: "vitest",
  });

  it("is a patient-actor 'granted' event with the current notice version", () => {
    expect(row).toEqual({
      patient_id: "p-1",
      event_type: "granted",
      method: "self_registration",
      notice_version: CURRENT_CONSENT_NOTICE_VERSION,
      signatory: "self",
      actor_kind: "patient",
      ip: "203.0.113.9",
      user_agent: "vitest",
    });
  });

  it("never sets created_by — no staff member vouched for a self-service grant", () => {
    expect("created_by" in row).toBe(false);
  });

  it("passes null ip/agent through unchanged", () => {
    const anon = selfRegistrationGrant({ patientId: "p-2", ip: null, userAgent: null });
    expect(anon.ip).toBeNull();
    expect(anon.user_agent).toBeNull();
  });
});
