import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BookingSchema } from "./booking";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00+08:00")); // Monday
});
afterEach(() => vi.useRealTimers());

const basePatient = {
  first_name: "Ana",
  last_name: "Cruz",
  middle_name: "",
  birthdate: "1990-01-01",
  sex: "female",
  phone: "09171234567",
  email: "ana@example.com",
  address: "",
  referral_source: "online_facebook",
  notes: "",
  marketing_consent: "off",
  service_agreement: "on",
};

describe("BookingSchema — lab-request form path", () => {
  it("accepts a lab_request booking with NO services (form-only)", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "lab_request",
      service_ids: [],
      scheduled_at: "",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a home_service booking with NO services", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "home_service",
      service_ids: [],
    });
    expect(r.success).toBe(true);
  });

  it("still accepts a lab_request booking WITH services", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "lab_request",
      service_ids: ["22222222-2222-4222-8222-222222222222"],
      scheduled_at: "",
    });
    expect(r.success).toBe(true);
  });
});

describe("BookingSchema — how did you hear about us", () => {
  const booking = { ...basePatient, branch: "lab_request", service_ids: [], scheduled_at: "" };

  it("keeps the answer", () => {
    const r = BookingSchema.safeParse(booking);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.referral_source).toBe("online_facebook");
  });

  it("requires an answer from a new patient, on the referral_source field", () => {
    for (const blank of ["", undefined]) {
      const r = BookingSchema.safeParse({ ...booking, referral_source: blank });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.path).toEqual(["referral_source"]);
        expect(r.error.issues[0]?.message).toBe("Tell us how you heard about us.");
      }
    }
  });

  it("rejects a value that is not a lookup id", () => {
    expect(BookingSchema.safeParse({ ...booking, referral_source: "facebook" }).success).toBe(false);
  });
});
