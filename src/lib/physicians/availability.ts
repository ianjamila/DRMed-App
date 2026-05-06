// Shared availability types + day-window resolver. Used by the booking
// slot picker and any UI that needs to know "is the doctor open at this
// date/time?".

export interface AvailabilityBlock {
  day_of_week: number; // 0 = Sunday … 6 = Saturday
  start_time: string; // "HH:MM:SS"
  end_time: string;
}

export interface AvailabilityOverride {
  override_on: string; // YYYY-MM-DD
  start_time: string | null; // null = full-day off
  end_time: string | null;
}

export interface PhysicianAvailability {
  blocks: AvailabilityBlock[];
  overrides: AvailabilityOverride[];
}

export interface DayWindow {
  available: boolean;
  start_time?: string;
  end_time?: string;
  reason?: "no_recurring" | "full_day_override" | "partial_override";
}

// Returns the open window for a physician on a given date in Manila.
// `dayOfWeek` matches Postgres convention (0 = Sunday). Times are
// HH:MM:SS strings; comparisons stay lexicographic.
export function dayWindowFor(
  date: string,
  dayOfWeek: number,
  availability: PhysicianAvailability | null,
): DayWindow {
  if (!availability) return { available: true };

  // Override wins. Full-day off → unavailable; partial → that window.
  const override = availability.overrides.find((o) => o.override_on === date);
  if (override) {
    if (override.start_time === null) {
      return { available: false, reason: "full_day_override" };
    }
    return {
      available: true,
      start_time: override.start_time,
      end_time: override.end_time ?? undefined,
      reason: "partial_override",
    };
  }

  const block = availability.blocks.find((b) => b.day_of_week === dayOfWeek);
  if (!block) return { available: false, reason: "no_recurring" };
  return {
    available: true,
    start_time: block.start_time,
    end_time: block.end_time,
  };
}

// "08:30" or "08:30:00" → minutes since midnight.
export function minutesOfDay(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h! * 60 + (m ?? 0);
}
