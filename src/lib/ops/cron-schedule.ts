/**
 * A Vercel cron schedule in plain words, in Manila time: "0 9 * * *" →
 * "Every day at 5:00 PM". Vercel reads every schedule as UTC and Manila is a
 * fixed UTC+8 (no daylight saving), so the shift is a constant 8 hours and can
 * carry a weekly run onto the next weekday ("0 23 * * 1" is Tuesday morning
 * in Manila, not Monday).
 *
 * Only the two shapes the clinic uses are read: daily ("M H * * *") and weekly
 * on one weekday ("M H * * D"). Anything else says so rather than guessing.
 */

const MANILA_OFFSET_MINUTES = 8 * 60;
const MINUTES_PER_DAY = 24 * 60;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function inRange(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

function clockTime(minutesOfDay: number): string {
  const hour24 = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

export function describeCronSchedule(schedule: string): string {
  const fallback = `Custom schedule (${schedule}, UTC)`;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [min, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minute = inRange(min, 59);
  const hourUtc = inRange(hour, 23);
  if (minute === null || hourUtc === null || dayOfMonth !== "*" || month !== "*") return fallback;

  const manila = hourUtc * 60 + minute + MANILA_OFFSET_MINUTES;
  const dayShift = Math.floor(manila / MINUTES_PER_DAY);
  const at = clockTime(manila % MINUTES_PER_DAY);

  if (dayOfWeek === "*") return `Every day at ${at}`;
  // Cron allows both 0 and 7 for Sunday.
  const weekday = inRange(dayOfWeek, 7);
  if (weekday === null) return fallback;
  return `Every ${WEEKDAYS[(weekday + dayShift) % 7]} at ${at}`;
}
