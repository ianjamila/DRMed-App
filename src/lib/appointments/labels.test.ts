import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  appointmentStatusLabel,
} from "./labels";

describe("appointmentStatusLabel", () => {
  it("labels every known status", () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(appointmentStatusLabel(s)).toBe(APPOINTMENT_STATUS_LABEL[s]);
    }
  });

  it("properly cases the two multi-word statuses", () => {
    expect(appointmentStatusLabel("pending_callback")).toBe(
      "Pending callback",
    );
    expect(appointmentStatusLabel("no_show")).toBe("No show");
  });

  it("falls back to underscore-to-space rendering for an unknown status", () => {
    expect(appointmentStatusLabel("some_future_status")).toBe(
      "some future status",
    );
  });

  it("does not render undefined for an unrecognised value", () => {
    expect(appointmentStatusLabel("bogus")).not.toBe("undefined");
    expect(appointmentStatusLabel("bogus")).toBe("bogus");
  });
});
