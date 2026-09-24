// Normalises the audit_log metadata written by the three staff-alert senders
// (contact-messages/alert.ts, cron/template-health, cron/dedup-digest) into
// one shape for the "Last sent" line on Admin Tools › Email Alerts
// (/staff/admin/settings/alerts). The three senders don't agree on a field
// name for "how many actually went out" — the website-message alert counts
// `sent`, the two cron senders count `emailed` — so this is the one place
// that maps either into the same summary rather than the page guessing per
// alert. Pure and framework-free so it's unit-testable without touching
// audit_log.
export interface RawAlertSentMetadata {
  recipients?: number;
  sent?: number;
  emailed?: number;
  failed?: number;
  skipped?: string;
}

export interface AlertLastSentSummary {
  recipients: number;
  sent: number;
  failed: number;
  skipped: string | null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normaliseAlertSentMetadata(metadata: unknown): AlertLastSentSummary {
  if (!metadata || typeof metadata !== "object") {
    return { recipients: 0, sent: 0, failed: 0, skipped: null };
  }
  const m = metadata as RawAlertSentMetadata;
  return {
    recipients: numberOr(m.recipients, 0),
    sent: numberOr(m.sent, numberOr(m.emailed, 0)),
    failed: numberOr(m.failed, 0),
    skipped: typeof m.skipped === "string" ? m.skipped : null,
  };
}
