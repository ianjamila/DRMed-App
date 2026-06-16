import { describe, it, expect } from "vitest";
import { labRequestStatus, validateLabRequestGate } from "./lab-request";

describe("labRequestStatus", () => {
  it("maps callback → pending_callback", () => {
    expect(labRequestStatus("callback")).toEqual({
      status: "pending_callback",
      pendingCallback: true,
    });
  });
  it("maps walk_in → confirmed", () => {
    expect(labRequestStatus("walk_in")).toEqual({
      status: "confirmed",
      pendingCallback: false,
    });
  });
});

describe("validateLabRequestGate", () => {
  it("passes when tests are selected and no form", () => {
    expect(
      validateLabRequestGate({ serviceCount: 2, hasForm: false, preference: null }),
    ).toEqual({ ok: true });
  });
  it("passes when a form is attached with a preference and no tests", () => {
    expect(
      validateLabRequestGate({ serviceCount: 0, hasForm: true, preference: "walk_in" }),
    ).toEqual({ ok: true });
  });
  it("passes when nothing is selected and no form (picking is optional)", () => {
    expect(
      validateLabRequestGate({ serviceCount: 0, hasForm: false, preference: null }),
    ).toEqual({ ok: true });
  });
  it("fails when a form is attached but no preference chosen", () => {
    const r = validateLabRequestGate({ serviceCount: 0, hasForm: true, preference: null });
    expect(r.ok).toBe(false);
  });
});
