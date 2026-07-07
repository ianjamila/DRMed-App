import { describe, it, expect } from "vitest";
import { PatientCreateSchema } from "./patient";
import { PatientImportRowSchema } from "./patient-import";

// M10 (PR 7): email is optional but must be a real address when present —
// it's the dedup key and the DRM-ID delivery channel.

const baseStaff = {
  first_name: "Juan",
  last_name: "Dela Cruz",
  middle_name: "",
  birthdate: "1990-01-15",
  sex: "male",
  phone: "",
  address: "",
  referral_source: "",
  referred_by_doctor: "",
  preferred_release_medium: "",
  senior_pwd_id_kind: "",
  senior_pwd_id_number: "",
  consent_given_today: "on",
};

const baseImport = {
  first_name: "Juan",
  last_name: "Dela Cruz",
  middle_name: "",
  birthdate: "1990-01-15",
  sex: "m",
  phone: "",
  address: "",
};

describe("PatientCreateSchema email", () => {
  it("accepts a valid address", () => {
    const r = PatientCreateSchema.safeParse({ ...baseStaff, email: "juan@example.com" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("juan@example.com");
  });

  it("blank becomes null", () => {
    const r = PatientCreateSchema.safeParse({ ...baseStaff, email: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBeNull();
  });

  it("rejects garbage", () => {
    const r = PatientCreateSchema.safeParse({ ...baseStaff, email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});

describe("PatientImportRowSchema email", () => {
  it("accepts a valid address", () => {
    const r = PatientImportRowSchema.safeParse({ ...baseImport, email: "juan@example.com" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("juan@example.com");
  });

  it("blank becomes null", () => {
    const r = PatientImportRowSchema.safeParse({ ...baseImport, email: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBeNull();
  });

  it("rejects garbage", () => {
    const r = PatientImportRowSchema.safeParse({ ...baseImport, email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});
