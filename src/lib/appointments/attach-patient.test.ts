import { describe, expect, it } from "vitest";
import { AttachPatientSchema } from "./attach-patient";

describe("AttachPatientSchema", () => {
  it("accepts an existing-patient pick", () => {
    const r = AttachPatientSchema.safeParse({
      mode: "existing",
      patient_id: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an existing-patient pick with no id", () => {
    const r = AttachPatientSchema.safeParse({ mode: "existing", patient_id: "" });
    expect(r.success).toBe(false);
  });

  it("accepts a new-patient registration with the required fields", () => {
    const r = AttachPatientSchema.safeParse({
      mode: "new",
      first_name: "Juan",
      last_name: "Dela Cruz",
      middle_name: "",
      birthdate: "1990-01-01",
      sex: "male",
      email: "juan@example.com",
      phone: "0917 000 0000",
      address: "",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.mode === "new") {
      // Blank optional fields normalize to null, not "".
      expect(r.data.middle_name).toBeNull();
      expect(r.data.address).toBeNull();
    }
  });

  it("rejects a new-patient registration missing a required email", () => {
    const r = AttachPatientSchema.safeParse({
      mode: "new",
      first_name: "Juan",
      last_name: "Dela Cruz",
      middle_name: "",
      birthdate: "1990-01-01",
      sex: "",
      email: "not-an-email",
      phone: "",
      address: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a walk_in mode — attaching resolves to a real patient, never another walk-in", () => {
    const r = AttachPatientSchema.safeParse({
      mode: "walk_in",
      walk_in_name: "Juan",
      walk_in_phone: "0917 000 0000",
    });
    expect(r.success).toBe(false);
  });
});
