import { describe, expect, it } from "vitest";
import { describeConsentEvent, latestIsBookingOnly, type ConsentHistoryEvent } from "./history";

const base: ConsentHistoryEvent = {
  id: "c-1",
  event_type: "granted",
  method: "onscreen_signature",
  created_at: "2026-09-24T08:12:02Z",
  signatory: "self",
  signatory_name: "Maria Santos",
  signatory_relationship: null,
  artifact_path: "p/sig.png",
  reason: null,
  source_form: null,
  consent_scope: "full",
  actor_kind: "staff",
  recorded_by: { full_name: "Ana Reception" },
};

describe("describeConsentEvent", () => {
  it("names an on-screen signature, the patient and the recording staff member", () => {
    expect(describeConsentEvent(base)).toEqual({
      what: "Signed on screen",
      note: null,
      signer: "Patient (Maria Santos)",
      recordedBy: "Ana Reception",
      viewable: true,
    });
  });

  it("says whether a paper form has its scan", () => {
    expect(describeConsentEvent({ ...base, method: "paper_wet_signature" }).note).toBe("scan attached");
    expect(describeConsentEvent({ ...base, method: "paper_wet_signature", artifact_path: null }).note).toBe(
      "no scan attached",
    );
  });

  it("flags a booking-only tick as not counting, whatever else it says", () => {
    const line = describeConsentEvent({
      ...base,
      method: "self_registration",
      source_form: "schedule",
      consent_scope: "booking_contact_only",
      actor_kind: "patient",
      recorded_by: null,
    });
    expect(line.what).toBe("Ticked the consent box on the online booking form");
    expect(line.note).toMatch(/does not count as consent/);
    expect(line.recordedBy).toBe("Patient, online");
  });

  it("names the registration form, and falls back when the form is unknown", () => {
    const reg = { ...base, method: "self_registration", source_form: "register", actor_kind: "patient" };
    expect(describeConsentEvent(reg).what).toBe("Ticked the consent box on the online registration form");
    expect(describeConsentEvent({ ...reg, source_form: null }).what).toBe("Ticked the consent box on the website form");
    expect(describeConsentEvent(reg).note).toBeNull();
  });

  it("shows a guardian with their relationship", () => {
    const line = describeConsentEvent({
      ...base,
      signatory: "guardian",
      signatory_name: "Rosa Dela Cruz",
      signatory_relationship: "Mother",
    });
    expect(line.signer).toBe("Guardian: Rosa Dela Cruz (Mother)");
  });

  it("does not invent a name the record lacks", () => {
    expect(describeConsentEvent({ ...base, signatory_name: null }).signer).toBe("Patient");
  });

  it("describes a withdrawal with its reason and no form to view", () => {
    const line = describeConsentEvent({
      ...base,
      event_type: "withdrawn",
      method: null,
      signatory: null,
      signatory_name: null,
      reason: "Patient asked in person",
    });
    expect(line).toEqual({
      what: "Withdrawn",
      note: "Reason: Patient asked in person",
      signer: null,
      recordedBy: "Ana Reception",
      viewable: false,
    });
  });
});

describe("latestIsBookingOnly", () => {
  const booking = { ...base, method: "self_registration", consent_scope: "booking_contact_only" };
  it("is true only when the newest event is a booking-only grant", () => {
    expect(latestIsBookingOnly([booking])).toBe(true);
    expect(latestIsBookingOnly([base, booking])).toBe(false);
    expect(latestIsBookingOnly([{ ...booking, event_type: "withdrawn" }])).toBe(false);
    expect(latestIsBookingOnly([])).toBe(false);
  });
});
