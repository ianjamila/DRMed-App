import { describe, it, expect } from "vitest";
import { RegistrationSchema } from "./registration";

const base = {
  first_name: "Maria",
  last_name: "Santos",
  middle_name: "",
  birthdate: "1991-04-12",
  sex: "female",
  phone: "09171234567",
  email: "maria@example.com",
  address: "",
  data_privacy_consent: "on",
  marketing_consent: "off",
};

describe("RegistrationSchema", () => {
  it("accepts a complete registration with consent", () => {
    const r = RegistrationSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("requires a valid email (DRM-ID is sent there + it's the dedup key)", () => {
    expect(RegistrationSchema.safeParse({ ...base, email: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });

  it("requires data-privacy consent to be accepted", () => {
    expect(RegistrationSchema.safeParse({ ...base, data_privacy_consent: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, data_privacy_consent: "off" }).success).toBe(false);
  });

  it("requires first/last name, birthdate format, and phone", () => {
    expect(RegistrationSchema.safeParse({ ...base, first_name: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, birthdate: "12/04/1991" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, phone: "" }).success).toBe(false);
  });

  it("normalises optional blanks to null and parses consent flags to booleans", () => {
    const r = RegistrationSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.middle_name).toBeNull();
      expect(r.data.address).toBeNull();
      expect(r.data.data_privacy_consent).toBe(true);
      expect(r.data.marketing_consent).toBe(false);
    }
  });
});
