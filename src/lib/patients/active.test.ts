import { describe, expect, it } from "vitest";
import {
  activePatients,
  inactivePatientError,
  isActivePatient,
  firstInactivePatient,
  type PatientLifecycle,
} from "./active";

const active: PatientLifecycle = { drm_id: "DRM-0001", deleted_at: null, merged_into_id: null };
const deleted: PatientLifecycle = { drm_id: "DRM-0002", deleted_at: "2026-09-24T01:00:00Z", merged_into_id: null };
const merged: PatientLifecycle = { drm_id: "DRM-0003", deleted_at: null, merged_into_id: "keep-id" };

describe("activePatients", () => {
  it("adds exactly the two lifecycle filters and returns the same builder", () => {
    const calls: [string, unknown][] = [];
    const builder = {
      is(column: string, value: unknown) {
        calls.push([column, value]);
        return builder;
      },
    };
    expect(activePatients(builder)).toBe(builder);
    expect(calls).toEqual([
      ["deleted_at", null],
      ["merged_into_id", null],
    ]);
  });
});

describe("isActivePatient", () => {
  it("is true only when neither deleted nor merged", () => {
    expect(isActivePatient(active)).toBe(true);
    expect(isActivePatient(deleted)).toBe(false);
    expect(isActivePatient(merged)).toBe(false);
    expect(isActivePatient(null)).toBe(false);
  });
});

describe("inactivePatientError", () => {
  it("names the DRM-ID and the way back", () => {
    expect(inactivePatientError(deleted)).toBe(
      "DRM-0002 was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.",
    );
    expect(inactivePatientError(merged)).toBe(
      "DRM-0003 was merged into another record. Open the surviving record instead.",
    );
    expect(inactivePatientError(null)).toBe("We couldn't find that patient. Search again.");
  });
});

describe("firstInactivePatient", () => {
  it("returns the first inactive row, or null when all are active", () => {
    expect(firstInactivePatient([active, merged, deleted])).toBe(merged);
    expect(firstInactivePatient([active])).toBeNull();
    expect(firstInactivePatient([])).toBeNull();
  });
});
