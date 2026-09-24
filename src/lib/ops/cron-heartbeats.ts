/**
 * Canonical scheduled legs. SQL stays standalone; cron-heartbeats.test.ts pins it.
 * `label` and `description` are what Cron Health shows an admin — plain words,
 * never the route path (`template-health?mode=weekly` meant nothing to anyone).
 */
export const CRON_HEARTBEATS = [
  {
    key: "sync-accounting",
    label: "Accounting sheet sync",
    description: "Copies new sales to the accounting Google Sheet (Lab Services, Doctor Consultations and Doctor Procedures HMO tabs).",
    path: "/api/cron/sync-accounting",
    schedule: "0 9 * * *",
    actions: ["accounting.sync.completed", "accounting.sync.empty", "accounting.sync.skipped"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "appointment-reminders",
    label: "Appointment reminders",
    description: "Emails patients a reminder the evening before a confirmed appointment.",
    path: "/api/cron/appointment-reminders",
    schedule: "0 10 * * *",
    actions: ["appointment.reminders.completed"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-18",
  },
  {
    key: "data-retention",
    label: "Old data clean-up",
    description: "Deletes day-old sign-in and PIN attempt records and long-expired visit PINs, as the data-retention policy requires.",
    path: "/api/cron/data-retention",
    schedule: "30 17 * * *",
    actions: ["data_retention.sweep"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "recurring-bills",
    label: "Recurring bills",
    description: "Creates draft bills from the recurring bill templates that are due.",
    path: "/api/cron/recurring-bills",
    schedule: "0 18 * * *",
    actions: ["recurring_bills.completed"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-18",
  },
  {
    key: "template-health",
    label: "Result template check (daily)",
    description: "Emails admins when a lab result template is broken or missing fields.",
    path: "/api/cron/template-health",
    schedule: "0 22 * * *",
    actions: ["result_template.health_alert"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-15",
  },
  {
    key: "template-health-weekly",
    label: "Result template summary (weekly)",
    description: "Emails admins a weekly summary of any result template problems.",
    path: "/api/cron/template-health?mode=weekly",
    schedule: "0 23 * * 1",
    actions: ["result_template.health_summary"],
    maxAge: 8 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-09-22",
  },
  {
    key: "dedup-digest",
    label: "Duplicate patients digest (weekly)",
    description: "Emails admins how many possible duplicate patient records are waiting for review.",
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
