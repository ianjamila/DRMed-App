import { describe, it, expect, vi } from "vitest";
import { resolvePatientCore, type ResolvePatientFields } from "./resolve";

const fields: ResolvePatientFields = {
  first_name: "Juan", last_name: "Dela Cruz", middle_name: null,
  birthdate: "1990-01-15", sex: "male", phone: "09171234567",
  email: "JUAN@example.com", address: null,
};

describe("resolvePatientCore", () => {
  it("reuses an existing patient and does not insert", async () => {
    const insertPatient = vi.fn();
    const r = await resolvePatientCore(
      { findExisting: async () => ({ id: "p1", drm_id: "DRM-0001" }), insertPatient },
      fields,
    );
    expect(r).toEqual({ ok: true, id: "p1", drm_id: "DRM-0001", reused: true });
    expect(insertPatient).not.toHaveBeenCalled();
  });

  it("lower-cases the email before the dedup lookup", async () => {
    const findExisting = vi.fn(async () => null);
    await resolvePatientCore(
      { findExisting, insertPatient: async () => ({ ok: true, id: "p2", drm_id: "DRM-0002" }) },
      fields,
    );
    expect(findExisting).toHaveBeenCalledWith({ email: "juan@example.com", last_name: "Dela Cruz", birthdate: "1990-01-15" });
  });

  it("inserts when no match, returning reused:false", async () => {
    const r = await resolvePatientCore(
      { findExisting: async () => null, insertPatient: async () => ({ ok: true, id: "p3", drm_id: "DRM-0003" }) },
      fields,
    );
    expect(r).toEqual({ ok: true, id: "p3", drm_id: "DRM-0003", reused: false });
  });

  it("hands referral_source to the insert for a new patient", async () => {
    const insertPatient = vi.fn(async () => ({ ok: true as const, id: "p4", drm_id: "DRM-0004" }));
    await resolvePatientCore(
      { findExisting: async () => null, insertPatient },
      { ...fields, referral_source: "online_facebook" },
    );
    expect(insertPatient).toHaveBeenCalledWith(
      expect.objectContaining({ referral_source: "online_facebook", email: "juan@example.com" }),
    );
  });

  it("propagates an insert error", async () => {
    const r = await resolvePatientCore(
      { findExisting: async () => null, insertPatient: async () => ({ ok: false, error: "boom" }) },
      fields,
    );
    expect(r).toEqual({ ok: false, error: "boom" });
  });
});
