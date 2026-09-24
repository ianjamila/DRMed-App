import { describe, it, expect } from "vitest";
import { PatientCreateSchema, PatientUpdateSchema } from "./patient";
import { REFERRAL_SOURCE_IDS } from "@/lib/patients/referral-sources";

// Referral source must be captured when a NEW patient is registered (it is the
// only attribution the app records); edits of existing records stay optional.

const base = {
  first_name: "Juan",
  last_name: "Dela Cruz",
  middle_name: "",
  birthdate: "1990-01-15",
  sex: "male",
  phone: "",
  email: "",
  address: "",
  referral_source: "",
  referred_by_doctor: "",
  preferred_release_medium: "",
  senior_pwd_id_kind: "",
  senior_pwd_id_number: "",
  consent_given_today: "on",
};

describe("PatientCreateSchema referral_source", () => {
  it("rejects a blank referral source with a reception-friendly message", () => {
    const r = PatientCreateSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["referral_source"]);
      expect(r.error.issues[0]?.message).toMatch(/referral source/i);
    }
  });

  it("accepts a known source", () => {
    const r = PatientCreateSchema.safeParse({ ...base, referral_source: "online_facebook" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.referral_source).toBe("online_facebook");
  });

  // The New Patient form offers every active referral_sources row (12), but
  // validation used to accept only the 8 ids from 0011 — Instagram, TikTok,
  // Returning patient and Gift code were offered and then refused.
  it("accepts every source the staff form offers", () => {
    expect(REFERRAL_SOURCE_IDS.length).toBe(12);
    for (const id of REFERRAL_SOURCE_IDS) {
      const r = PatientCreateSchema.safeParse({ ...base, referral_source: id });
      expect(r.success, id).toBe(true);
    }
  });

  it("rejects an unknown source", () => {
    const r = PatientCreateSchema.safeParse({ ...base, referral_source: "tiktok" });
    expect(r.success).toBe(false);
  });
});

describe("PatientUpdateSchema referral_source", () => {
  it("still allows a blank source on edit (legacy records)", () => {
    const r = PatientUpdateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.referral_source).toBeNull();
  });
});
