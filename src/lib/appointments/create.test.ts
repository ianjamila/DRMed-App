import { describe, expect, it, vi } from "vitest";
import { insertWithPatientRecovery, LOOKUP_AGAIN_ERROR } from "./patient-recovery";

const p = (resolution: "existing" | "reused" | "created" | "walk_in", patientId = "p1") =>
  ({ patientId, drmId: null, email: null, resolution });
const refused = { data: null, error: { code: "P0058", message: "patient DRM-0001 is deleted" } };
const done = { data: ["a1"], error: null };

describe("insertWithPatientRecovery", () => {
  it("re-resolves once for a typed-in patient and books the fresh record", async () => {
    const insert = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(done);
    const resolveAgain = vi.fn(async () => ({ ok: true as const, patient: p("created", "p2") }));
    const r = await insertWithPatientRecovery({ patient: p("reused"), insert, resolveAgain });
    expect(r).toMatchObject({ ok: true, patient: { patientId: "p2" } });
    expect(resolveAgain).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[1][0].patientId).toBe("p2");
  });
  it("never swaps a patient chosen by id — generic lookup-again, no deletion wording", async () => {
    const r = await insertWithPatientRecovery({ patient: p("existing"), insert: vi.fn(async () => refused), resolveAgain: vi.fn() });
    expect(r).toEqual({ ok: false, error: LOOKUP_AGAIN_ERROR });
    expect(LOOKUP_AGAIN_ERROR).not.toMatch(/delet|merg/i);
  });
  it("gives up after one re-resolve", async () => {
    const insert = vi.fn(async () => refused);
    const r = await insertWithPatientRecovery({ patient: p("created"), insert, resolveAgain: async () => ({ ok: true, patient: p("created", "p3") }) });
    expect(r).toEqual({ ok: false, error: LOOKUP_AGAIN_ERROR });
    expect(insert).toHaveBeenCalledTimes(2);
  });
  it("retries a moved record (P0072) once with the same patient", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ data: null, error: { code: "P0072", message: "x" } }).mockResolvedValueOnce(done);
    const r = await insertWithPatientRecovery({ patient: p("existing"), insert, resolveAgain: vi.fn() });
    expect(r.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
  });
  it("passes other errors through without recovering", async () => {
    const other = { data: null, error: { code: "23505", message: "duplicate" } };
    const insert = vi.fn(async () => other);
    const resolveAgain = vi.fn();
    const r = await insertWithPatientRecovery({ patient: p("reused"), insert, resolveAgain });
    expect(r).toEqual({ ok: false, error: other.error });
    expect(resolveAgain).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
