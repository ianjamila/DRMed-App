import { manilaSlotFor, minutesOfDayHHMM, type BookingBranch } from "@/lib/validations/booking";

// One open window per date (mirrors lib/physicians/availability DayWindow).
export interface DayWindowLike {
  available: boolean;
  start_time?: string;
  end_time?: string;
  reason?: string;
}

export interface ServiceRow {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
  fasting_required: boolean;
  requires_time_slot: boolean;
  allow_concurrent: boolean;
}

export type ConflictKind =
  | "slot_taken"
  | "day_closed"
  | "outside_hours"
  | "doctor_unavailable";

export interface BookingConflict {
  kind: ConflictKind;
  message: string;
}

export interface TimingArgs {
  branch: BookingBranch;
  services: ServiceRow[];
  // A validated ISO string (real 30-min Manila slot) or null.
  scheduledAt: string | null;
  // Required only for the doctor branch — caller pre-fetches it so this stays DB-free.
  doctor?: {
    byAppointment: boolean; // physician has no recurring schedule rows
    dayClosed: boolean;
    window: DayWindowLike;
    existingBookingCount: number; // non-cancelled appts already at this physician+slot
    allowConcurrent: boolean;
  };
}

export type TimingDecision =
  | { ok: true; pendingCallback: boolean; scheduledAtIso: string | null; conflicts: BookingConflict[] }
  | { ok: false; error: string };

// Conflict messages are kept byte-identical to the public booking flow so the
// strict (public) caller's user-facing errors don't regress. The order pushed
// here mirrors the public flow's short-circuit order (closure → window → hours
// → concurrency), so a strict caller using conflicts[0] reproduces it exactly.
export function decideAppointmentTiming(args: TimingArgs): TimingDecision {
  const { branch, services, scheduledAt } = args;

  if (branch === "diagnostic_package") {
    return { ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] };
  }
  if (branch === "home_service") {
    return { ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] };
  }
  if (branch === "lab_request") {
    const slotRequired = services.some((s) => s.requires_time_slot);
    if (!slotRequired) {
      return { ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] };
    }
    if (!scheduledAt) {
      return {
        ok: false,
        error: "One of the selected tests needs a specific time slot. Please pick a date and time.",
      };
    }
    return { ok: true, pendingCallback: false, scheduledAtIso: scheduledAt, conflicts: [] };
  }

  // doctor_appointment
  const doctor = args.doctor;
  if (!doctor) {
    return { ok: false, error: "Physician availability was not resolved." };
  }
  if (doctor.byAppointment) {
    return { ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] };
  }
  if (!scheduledAt) {
    return { ok: false, error: "Please pick a date and time." };
  }

  const conflicts: BookingConflict[] = [];
  if (doctor.dayClosed) {
    conflicts.push({ kind: "day_closed", message: "That day is closed. Please pick another." });
  }
  if (!doctor.window.available) {
    conflicts.push({
      kind: "doctor_unavailable",
      message:
        doctor.window.reason === "full_day_override"
          ? "The doctor is unavailable that day. Please pick another slot."
          : "The doctor isn't scheduled that day. Please pick another slot.",
    });
  } else {
    const slot = manilaSlotFor(new Date(scheduledAt));
    const slotMinutes = slot.hour * 60 + slot.minute;
    const startMin = doctor.window.start_time ? minutesOfDayHHMM(doctor.window.start_time) : 8 * 60;
    const endMin = doctor.window.end_time ? minutesOfDayHHMM(doctor.window.end_time) : 16 * 60 + 30;
    if (slotMinutes < startMin || slotMinutes >= endMin) {
      conflicts.push({ kind: "outside_hours", message: "That time is outside the doctor's hours. Please pick another." });
    }
  }
  if (!doctor.allowConcurrent && doctor.existingBookingCount > 0) {
    conflicts.push({ kind: "slot_taken", message: "That slot was just taken. Please pick another time." });
  }

  return { ok: true, pendingCallback: false, scheduledAtIso: scheduledAt, conflicts };
}
