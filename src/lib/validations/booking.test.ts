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
