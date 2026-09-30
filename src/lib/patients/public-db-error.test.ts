import { describe, expect, it } from "vitest";
import { PUBLIC_SAVE_ERROR, PUBLIC_SLOT_TAKEN_ERROR, publicDbError } from "./public-db-error";

describe("publicDbError", () => {
  it("never passes a hand-written staff message through", () => {
    for (const err of [
      { code: "23514", message: "a result can only hold one patient's tests" },
      { code: "P0058", message: "patient DRM-0001 is deleted" },
      { code: "P0072", message: "this patient record changed while the booking was being saved — try again" },
      { code: "23505", message: 'duplicate key value violates unique constraint "patients_drm_id_key"' },
      { message: "connection terminated" },
    ]) {
      expect(publicDbError(err)).toBe(PUBLIC_SAVE_ERROR);
    }
  });

  it("tells the patient when the slot was just taken (P0040)", () => {
    expect(publicDbError({ code: "P0040", message: "slot full at 2026-09-30T01:00:00Z" })).toBe(PUBLIC_SLOT_TAKEN_ERROR);
  });

  it("does not hint that a record was deleted or merged", () => {
    expect(PUBLIC_SAVE_ERROR).not.toMatch(/delet|merg/i);
  });
});
