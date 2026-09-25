import { describe, expect, it } from "vitest";
import { epochMicros, isUpdatedSinceDownload } from "./patient-update-marker";

describe("isUpdatedSinceDownload — the portal's Result updated marker", () => {
  const edited = "2026-09-25T06:00:00.500000+00:00";

  it("shows when the patient downloaded BEFORE the latest edit", () => {
    expect(
      isUpdatedSinceDownload({ amended_at: edited, patient_last_downloaded_at: "2026-09-24T01:00:00+00:00" }),
    ).toBe(true);
  });

  it("hides once they download the new version", () => {
    expect(
      isUpdatedSinceDownload({ amended_at: edited, patient_last_downloaded_at: "2026-09-25T06:05:00.1+00:00" }),
    ).toBe(false);
  });

  it("never shows to a patient who never downloaded (their first copy is already the corrected one)", () => {
    expect(isUpdatedSinceDownload({ amended_at: edited, patient_last_downloaded_at: null })).toBe(false);
  });

  it("never shows for a result that was never edited", () => {
    expect(
      isUpdatedSinceDownload({ amended_at: null, patient_last_downloaded_at: "2026-09-24T01:00:00+00:00" }),
    ).toBe(false);
    expect(isUpdatedSinceDownload(null)).toBe(false);
  });

  it("keeps microsecond precision: a download that raced the edit is stored 1µs before it and must still show", () => {
    // 0176 writes amended_at - 1µs when the served object was already replaced.
    // Date.parse would round both to …00.500 and call them equal.
    expect(
      isUpdatedSinceDownload({
        amended_at: "2026-09-25T06:00:00.500001+00:00",
        patient_last_downloaded_at: "2026-09-25T06:00:00.5+00:00",
      }),
    ).toBe(true);
  });

  it("compares across offsets and psql's short form", () => {
    expect(
      isUpdatedSinceDownload({
        amended_at: "2026-09-25 14:00:00+08",
        patient_last_downloaded_at: "2026-09-25T05:59:59.999999Z",
      }),
    ).toBe(true);
    expect(
      isUpdatedSinceDownload({
        amended_at: "2026-09-25 14:00:00+08",
        patient_last_downloaded_at: "2026-09-25T06:00:00.000001Z",
      }),
    ).toBe(false);
  });

  it("treats an unreadable timestamp as no marker", () => {
    expect(isUpdatedSinceDownload({ amended_at: "garbage", patient_last_downloaded_at: "2026-09-24T01:00:00Z" })).toBe(false);
    expect(epochMicros("not a date")).toBeNull();
  });

  it("epochMicros pads a short fraction and ignores digits past microseconds", () => {
    expect(epochMicros("1970-01-01T00:00:01.5Z")).toBe(1_500_000);
    expect(epochMicros("1970-01-01T00:00:00.0000019Z")).toBe(1);
  });
});
