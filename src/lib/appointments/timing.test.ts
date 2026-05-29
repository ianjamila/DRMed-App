import { describe, it, expect } from "vitest";
import { decideAppointmentTiming, type ServiceRow } from "./timing";

function svc(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "s1", name: "Test", kind: "lab_test", is_active: true,
    fasting_required: false, requires_time_slot: false, allow_concurrent: true,
    ...over,
  };
}

describe("decideAppointmentTiming", () => {
  it("diagnostic_package is a confirmed walk-in: no time, no callback", () => {
    const r = decideAppointmentTiming({ branch: "diagnostic_package", services: [svc({ kind: "lab_package" })], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] });
  });

  it("home_service is always pending_callback", () => {
    const r = decideAppointmentTiming({ branch: "home_service", services: [svc()], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] });
  });

  it("lab_request with no requires_time_slot service is a confirmed walk-in", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: false })], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] });
  });

  it("lab_request needing a slot errors when none is given", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: true })], scheduledAt: null });
    expect(r.ok).toBe(false);
  });

  it("lab_request needing a slot accepts the given slot", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: true })], scheduledAt: "2026-06-01T01:00:00.000Z" });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: "2026-06-01T01:00:00.000Z", conflicts: [] });
  });

  it("doctor by-appointment (no schedule) is pending_callback", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })], scheduledAt: null,
      doctor: { byAppointment: true, dayClosed: false, window: { available: false }, existingBookingCount: 0, allowConcurrent: true },
    });
    expect(r).toEqual({ ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] });
  });

  it("doctor with a clear slot has no conflicts", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })],
      scheduledAt: "2026-06-01T01:00:00.000Z", // 09:00 Manila
      doctor: { byAppointment: false, dayClosed: false, window: { available: true, start_time: "08:00", end_time: "17:00" }, existingBookingCount: 0, allowConcurrent: false },
    });
    expect(r.ok && r.conflicts).toEqual([]);
  });

  it("flags day_closed first, then outside_hours and slot_taken", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })],
      scheduledAt: "2026-06-01T01:00:00.000Z", // 09:00 Manila
      doctor: { byAppointment: false, dayClosed: true, window: { available: true, start_time: "10:00", end_time: "12:00" }, existingBookingCount: 1, allowConcurrent: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflicts.map((c) => c.kind)).toEqual(["day_closed", "outside_hours", "slot_taken"]);
  });

  it("flags slot_taken only when allow_concurrent is false", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation", allow_concurrent: true })],
      scheduledAt: "2026-06-01T01:00:00.000Z",
      doctor: { byAppointment: false, dayClosed: false, window: { available: true, start_time: "08:00", end_time: "17:00" }, existingBookingCount: 3, allowConcurrent: true },
    });
    expect(r.ok && r.conflicts).toEqual([]);
  });
});
