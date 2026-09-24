import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StaffBookingSchema, STAFF_BOOKING_NOTES_MAX } from "./staff-booking";

// Freeze time so the 60-day cap + slot validity are deterministic.
// 2026-06-01 is a Monday in Manila.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00+08:00"));
});
afterEach(() => vi.useRealTimers());

const baseExisting = {
  patient: { mode: "existing", patient_id: "11111111-1111-4111-8111-111111111111" },
  branch: "diagnostic_package",
  service_ids: ["22222222-2222-4222-8222-222222222222"],
  send_confirmation: true,
  override: false,
  source: "phone",
};

describe("StaffBookingSchema", () => {
  it("accepts an existing-patient diagnostic package with no time", () => {
    const r = StaffBookingSchema.safeParse(baseExisting);
    expect(r.success).toBe(true);
  });

  it("allows a same-day / <1h-ahead slot (relaxed timing)", () => {
    // 08:30 Manila today, only 30 min ahead — the public ≥1h rule is dropped.
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-06-01T08:30:00+08:00",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-slot time (Sunday)", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-06-07T09:00:00+08:00", // Sunday
    });
    expect(r.success).toBe(false);
  });

  it("rejects a slot more than 60 days out", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-09-01T09:00:00+08:00",
    });
    expect(r.success).toBe(false);
  });

  it("requires service_id + physician_id for the doctor branch", () => {
    const r = StaffBookingSchema.safeParse({
      patient: { mode: "existing", patient_id: "11111111-1111-4111-8111-111111111111" },
      branch: "doctor_appointment",
      send_confirmation: true,
      override: false,
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one service for non-doctor branches", () => {
    const r = StaffBookingSchema.safeParse({ ...baseExisting, service_ids: [] });
    expect(r.success).toBe(false);
  });

  it("validates the new-patient sub-form and requires email", () => {
    const ok = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: {
        mode: "new", first_name: "Ana", last_name: "Reyes", middle_name: "",
        birthdate: "1995-03-10", sex: "female", email: "ana@example.com", phone: "0917", address: "",
      },
    });
    expect(ok.success).toBe(true);

    const noEmail = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: { mode: "new", first_name: "Ana", last_name: "Reyes", middle_name: "", birthdate: "1995-03-10", sex: "female", email: "", phone: "0917", address: "" },
    });
    expect(noEmail.success).toBe(false);
  });

  it("validates the walk-in sub-form (name + phone)", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: { mode: "walk_in", walk_in_name: "Juan", walk_in_phone: "09171234567" },
    });
    expect(r.success).toBe(true);
  });

  it("defaults send_confirmation and override", () => {
    const r = StaffBookingSchema.safeParse({
      patient: { mode: "existing", patient_id: "11111111-1111-4111-8111-111111111111" },
      branch: "diagnostic_package",
      service_ids: ["22222222-2222-4222-8222-222222222222"],
      source: "phone",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.send_confirmation).toBe(true);
      expect(r.data.override).toBe(false);
    }
  });

  describe("source", () => {
    it("rejects a missing source", () => {
      const withoutSource: Record<string, unknown> = { ...baseExisting };
      delete withoutSource.source;
      const r = StaffBookingSchema.safeParse(withoutSource);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.message === "Choose how they reached us.")).toBe(true);
      }
    });

    it("rejects an empty source", () => {
      const r = StaffBookingSchema.safeParse({ ...baseExisting, source: "" });
      expect(r.success).toBe(false);
    });

    it("rejects a system-only source staff cannot pick", () => {
      // online_booking/patient_portal are stamped by the system, never
      // offered in the staff slide-over's <select> — reject them here too.
      const r = StaffBookingSchema.safeParse({ ...baseExisting, source: "online_booking" });
      expect(r.success).toBe(false);
    });

    it("accepts every staff-selectable source, including website_message", () => {
      for (const source of ["phone", "sms", "messenger", "walk_in", "referral", "other", "website_message"]) {
        const r = StaffBookingSchema.safeParse({ ...baseExisting, source });
        expect(r.success, `expected "${source}" to be accepted`).toBe(true);
      }
    });
  });

  describe("notes", () => {
    it("accepts notes at the max length", () => {
      const r = StaffBookingSchema.safeParse({ ...baseExisting, notes: "a".repeat(STAFF_BOOKING_NOTES_MAX) });
      expect(r.success).toBe(true);
    });

    it("rejects notes over the max length", () => {
      const r = StaffBookingSchema.safeParse({ ...baseExisting, notes: "a".repeat(STAFF_BOOKING_NOTES_MAX + 1) });
      expect(r.success).toBe(false);
    });

    it("treats omitted/empty notes as null", () => {
      const omitted = StaffBookingSchema.safeParse(baseExisting);
      expect(omitted.success).toBe(true);
      if (omitted.success) expect(omitted.data.notes).toBeNull();

      const empty = StaffBookingSchema.safeParse({ ...baseExisting, notes: "" });
      expect(empty.success).toBe(true);
      if (empty.success) expect(empty.data.notes).toBeNull();
    });
  });

  describe("contact_message_id", () => {
    it("defaults to undefined when omitted", () => {
      const r = StaffBookingSchema.safeParse(baseExisting);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.contact_message_id).toBeUndefined();
    });

    it("treats an empty string the same as omitted", () => {
      const r = StaffBookingSchema.safeParse({ ...baseExisting, contact_message_id: "" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.contact_message_id).toBeUndefined();
    });

    it("accepts a real uuid", () => {
      const id = "33333333-3333-4333-8333-333333333333";
      const r = StaffBookingSchema.safeParse({ ...baseExisting, contact_message_id: id });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.contact_message_id).toBe(id);
    });

    it("rejects a malformed id", () => {
      const r = StaffBookingSchema.safeParse({ ...baseExisting, contact_message_id: "not-a-uuid" });
      expect(r.success).toBe(false);
    });
  });
});
