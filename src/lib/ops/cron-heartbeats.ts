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
  {
    key: "sheet-sync",
    label: "Reception sheet sync",
    description: "Copies new patients and the day's lab and consultation lines from the reception Google Sheet. Skipped while paused.",
    path: "/api/cron/sheet-sync",
    schedule: "0 16 * * *",
    actions: ["sheet_sync.completed", "sheet_sync.skipped"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-29",
    // sheet-sync is the only watched task a person (or the CLI) can also
    // trigger: "Sync now" on the admin page and `npm run sheet:sync` both
    // audit actor_type 'system' too (run.ts), so actor_type alone would let a
    // manual/CLI run mask a stopped Vercel cron. Every audited action here
    // carries `trigger` in its metadata (run.ts's audit() call) — require it.
    requireTrigger: "cron",
  },
  {
    key: "stale-bookings",
    label: "Bookings not acted on (daily)",
    description: "Emails reception a morning list of bookings with no set time that nobody has acted on for 3 days or more.",
    path: "/api/cron/stale-bookings",
    schedule: "30 0 * * *",
    actions: ["system.stale_bookings.completed"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-27",
  },
  {
    key: "patient-sources-weekly",
    label: "Patient sources email (weekly)",
    description: "Emails admins a Monday summary of last week's new patients by channel, revenue, referrers and cost per new patient.",
    path: "/api/cron/patient-sources-weekly",
    schedule: "0 23 * * 0",
    actions: ["system.patient_sources_weekly.completed"],
    maxAge: 8 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-10-05",
  },
  {
    key: "patient-sources-monthly",
    label: "Patient sources email (monthly)",
    description: "Emails admins a summary on the 1st of last month's new patients by channel, revenue, referrers and cost per new patient.",
    path: "/api/cron/patient-sources-monthly",
    schedule: "0 0 1 * *",
    actions: ["system.patient_sources_monthly.completed"],
    maxAge: 32 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-11-02",
  },
  {
    key: "release-notices",
    label: "Result notice sender",
    description: "Sends and retries the patients' result-ready messages that did not go out the first time, and records how each one ended. Runs every 5 minutes once it is switched on.",
    path: "/api/cron/release-notices",
    schedule: "*/5 * * * *",
    actions: ["system.release_notices.sweep.completed"],
    maxAge: 6 * 60 * 60 * 1000,
    // Bootstrap guard (see cron-watchdog.yml): the expected merge day of the PR
    // that added this route. The job does nothing until the owner sets the two
    // Vault secrets AND switches release_notice_settings.enabled on, so move
    // this date to the day after that switch-on if the watchdog goes red first.
    activeFrom: "2026-10-02",
    // Scheduled by a Supabase pg_cron job (0212), NOT by vercel.json.
    scheduler: "pg_cron",
    // Watched ONLY while the strict flag is on and was switched on more than
    // NOTICE_WATCH_GRACE_MINUTES ago; while it is off nothing is ever STALE.
    watchWhen: "release-notices-enabled",
    // Sentry check-in margin (minutes): the default 60 is far too loose for a 5-minute
    // schedule. pg_cron + pg_net + a cold function can drift a few minutes.
    checkinMargin: 10,
  },
] as const;

/** Minutes the release-notice flag must have been on before its sweeper is watched. */
export const NOTICE_WATCH_GRACE_MINUTES = 15;

/** The watchdog's `release-notices-enabled` gate (cron-watchdog.yml), mirrored for Cron Health. */
export function isNoticeSweepWatched(enabled: boolean, updatedAt: string | null, now: number): boolean {
  return enabled && updatedAt !== null && now - Date.parse(updatedAt) > NOTICE_WATCH_GRACE_MINUTES * 60_000;
}

export type CronKey = (typeof CRON_HEARTBEATS)[number]["key"];
export type CronStatus = "healthy" | "pending" | "stale";

/** maxAge is milliseconds; activeFrom is a UTC date, matching the SQL session. */
export function deriveCronStatus(
  lastSeen: string | null,
  now: number,
  maxAge: number,
  activeFrom: string,
  watched = true,
): CronStatus {
  if (!watched) return "pending";
  if (lastSeen === null) {
    return now < Date.parse(`${activeFrom}T00:00:00Z`) ? "pending" : "stale";
  }
  return now - Date.parse(lastSeen) > maxAge ? "stale" : "healthy";
}
