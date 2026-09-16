/** Canonical scheduled legs. SQL stays standalone; cron-heartbeats.test.ts pins it. */
export const CRON_HEARTBEATS = [
  {
    key: "sync-accounting",
    path: "/api/cron/sync-accounting",
    schedule: "0 9 * * *",
    actions: ["accounting.sync.completed", "accounting.sync.empty", "accounting.sync.skipped"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "appointment-reminders",
    path: "/api/cron/appointment-reminders",
    schedule: "0 10 * * *",
    actions: ["appointment.reminders.completed"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-18",
  },
  {
    key: "data-retention",
    path: "/api/cron/data-retention",
    schedule: "30 17 * * *",
    actions: ["data_retention.sweep"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "recurring-bills",
    path: "/api/cron/recurring-bills",
    schedule: "0 18 * * *",
    actions: ["recurring_bills.completed"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-18",
  },
  {
    key: "template-health",
    path: "/api/cron/template-health",
    schedule: "0 22 * * *",
    actions: ["result_template.health_alert"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "template-health-weekly",
    path: "/api/cron/template-health?mode=weekly",
    schedule: "0 23 * * 1",
    actions: ["result_template.health_summary"],
    maxAge: 8 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-09-22",
  },
  {
    key: "dedup-digest",
    path: "/api/cron/dedup-digest",
    schedule: "0 1 * * 1",
    actions: ["system.dedup_digest.completed"],
    maxAge: 8 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-09-22",
  },
] as const;

export type CronKey = (typeof CRON_HEARTBEATS)[number]["key"];
export type CronStatus = "healthy" | "pending" | "stale";

/** maxAge is milliseconds; activeFrom is a UTC date, matching the SQL session. */
export function deriveCronStatus(
  lastSeen: string | null,
  now: number,
  maxAge: number,
  activeFrom: string,
): CronStatus {
  if (lastSeen === null) {
    return now < Date.parse(`${activeFrom}T00:00:00Z`) ? "pending" : "stale";
  }
  return now - Date.parse(lastSeen) > maxAge ? "stale" : "healthy";
}
