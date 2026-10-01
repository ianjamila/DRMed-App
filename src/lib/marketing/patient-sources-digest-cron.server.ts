/**
 * The weekly / monthly Patient Sources owner email — the cron's brain.
 *
 * DELIVERY RULE: at most once, automatically. Per recipient: CLAIM the send in SQL
 * (`_ps_digest_claim`, one atomic statement), SEND with an idempotency key, RECORD
 * the outcome. When delivery is uncertain nothing re-sends by itself — the row goes
 * `unknown` and the monitor goes red until an operator checks Resend and retries
 * with `?period_from=…&include_unknown=1`.
 *
 * Statuses: sending → sent | failed (definite: Resend refused, or the send was
 * skipped) | unknown (the request may have reached Resend). A record-write error is
 * reported and flags the monitor but is never thrown after a send; the row stays
 * `sending` and becomes `unknown` when stale (15 min, in the claim).
 *
 * Injected deps keep this unit-testable; `runDigestCron` wires the real ones.
 * Like patient-sources-digest.server.ts it never names an admin-only function.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { audit, type AuditEntry } from "@/lib/audit/log";
import { manilaISODate, shiftISODate } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, type SendEmailInput, type SendResult } from "@/lib/notifications/email";
import { resolveStaffAlertRecipients, type ResolvedAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { alertSkipReason, STAFF_ALERTS } from "@/lib/notifications/staff-alerts";
import { buildPatientSourcesDigestEmail, type DigestEmailBuild } from "./patient-sources-digest.server";
import { DIGEST_ALERT_KEY, digestPeriods, periodEnd, type DigestAlertKey, type DigestKind } from "./patient-sources-digest";

type Db = SupabaseClient<Database>;

export type DigestRowStatus = "sending" | "sent" | "failed" | "unknown";

export interface DigestSendStore {
  /** The atomic claim: the new attempt number, or null when this call did not claim (sent / in flight / unknown). */
  claim(
    key: DigestAlertKey, from: string, to: string, recipient: string, includeUnknown: boolean,
  ): Promise<{ attempts: number | null; error: string | null }>;
  statusOf(key: DigestAlertKey, from: string, recipient: string): Promise<DigestRowStatus | null>;
  /** Writes the outcome of a send this run claimed. Returns an error message, or null. */
  record(
    key: DigestAlertKey, from: string, recipient: string,
    patch: { status: "sent" | "failed" | "unknown"; providerId?: string | null; error?: string | null },
  ): Promise<string | null>;
}

export function supabaseDigestStore(admin: Db): DigestSendStore {
  return {
    async claim(key, from, to, recipient, includeUnknown) {
      const { data, error } = await admin.rpc("_ps_digest_claim", {
        p_key: key, p_from: from, p_to: to, p_recipient: recipient, p_include_unknown: includeUnknown,
      });
      if (error) return { attempts: null, error: error.message };
      return { attempts: typeof data === "number" ? data : null, error: null };
    },
    async statusOf(key, from, recipient) {
      const { data } = await admin
        .from("patient_sources_digest_sends")
        .select("status")
        .eq("alert_key", key)
        .eq("period_from", from)
        .eq("recipient", recipient)
        .maybeSingle();
      return (data?.status as DigestRowStatus | undefined) ?? null;
    },
    async record(key, from, recipient, patch) {
      const { data, error } = await admin
        .from("patient_sources_digest_sends")
        .update({
          status: patch.status,
          provider_id: patch.providerId ?? null,
          last_error: patch.error ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("alert_key", key)
        .eq("period_from", from)
        .eq("recipient", recipient)
        // Only a row this run claimed, or one an operator re-opened — never a row someone else finished.
        .in("status", ["sending", "unknown"])
        .select("recipient");
      if (error) return error.message;
      return (data?.length ?? 0) === 0 ? "no claimed row to update" : null;
    },
  };
}

export interface DigestRunDeps {
  now: () => Date;
  resolveRecipients: (key: DigestAlertKey) => Promise<ResolvedAlertRecipients>;
  build: (kind: DigestKind, anchorISO: string) => Promise<DigestEmailBuild>;
  store: DigestSendStore;
  send: (input: SendEmailInput) => Promise<SendResult>;
  audit: (entry: AuditEntry) => Promise<void>;
  reportError: (a: { scope: string; error: unknown; metadata?: Record<string, unknown> }) => Promise<void>;
}

export interface DigestRunOptions {
  kind: DigestKind;
  /** A validated earlier period start (parseDigestParams) — re-targets the run. */
  periodFrom?: string | null;
  includeUnknown?: boolean;
}

export interface DigestRunResult {
  status: number;
  body: Record<string, unknown>;
  /** Mark the cron monitor failed (partial / uncertain delivery, or the digest could not be built). */
  failed: boolean;
}

interface Counts {
  recipients: number;
  sent: number;
  failed: number;
  unknown: number;
  alreadySent: number;
  inFlight: number;
  skippedSends: number;
}
const ZERO: Counts = { recipients: 0, sent: 0, failed: 0, unknown: 0, alreadySent: 0, inFlight: 0, skippedSends: 0 };

const SCOPE = "cron/patient-sources-digest";

/** The reason shown after "sent to X of Y" when a run sent nothing — a string only (normaliseAlertSentMetadata). */
function deliveryNote(c: Counts, sendSkipReason: string | null): string | undefined {
  if (c.sent > 0) return undefined;
  if (c.recipients > 0 && c.alreadySent === c.recipients) return "already sent to everyone for this period";
  if (sendSkipReason && c.failed > 0 && c.failed === c.skippedSends) return sendSkipReason;
  return undefined;
}

export async function runPatientSourcesDigest(deps: DigestRunDeps, opts: DigestRunOptions): Promise<DigestRunResult> {
  const { kind } = opts;
  const key = DIGEST_ALERT_KEY[kind];
  const includeUnknown = opts.includeUnknown === true;
  const todayISO = manilaISODate(deps.now())!;
  // A retry re-targets an earlier period by passing the day AFTER it, so a week/month
  // rollover between the failure and the retry cannot move the target.
  const anchor = opts.periodFrom ? shiftISODate(periodEnd(kind, opts.periodFrom), 1) : todayISO;
  const planned = digestPeriods(kind, anchor).cur;

  // Who gets it — resolved NOW, so someone switched off since a failed run is not emailed.
  const alert = await deps.resolveRecipients(key);
  const recipientSkip = alertSkipReason(alert);

  let trouble = false;
  const finish = async (c: Counts, reason: string | undefined, period = planned): Promise<DigestRunResult> => {
    // An unconfirmed delivery goes in the same string the Email Alerts "Last sent" line shows, so the owner
    // sees it there and not only through the failed monitor / watchdog.
    const skipped = [
      reason,
      c.unknown > 0 ? `${c.unknown} deliver${c.unknown === 1 ? "y" : "ies"} not confirmed — check Resend before re-sending` : undefined,
    ]
      .filter(Boolean)
      .join("; ") || undefined;
    const base = {
      period_from: period.from,
      period_to: period.to,
      recipients: c.recipients,
      sent: c.sent,
      failed: c.failed,
      unknown: c.unknown,
      already_sent: c.alreadySent,
    };
    await deps.audit({
      actor_id: null,
      actor_type: "system",
      action: STAFF_ALERTS[key].sentAction,
      metadata: {
        ...base,
        ...(c.inFlight > 0 ? { in_flight: c.inFlight } : {}),
        ...(skipped ? { skipped } : {}),
        ...(alert.loadError ? { recipients_error: alert.loadError } : {}),
      } as Json,
    });
    // The heartbeat the watchdog reads — on EVERY non-failing path.
    await deps.audit({ actor_id: null, actor_type: "system", action: `system.${key}.completed`, metadata: base as Json });
    return {
      status: 200,
      body: { ...base, ...(skipped ? { skipped } : {}) },
      failed: c.failed > 0 || c.unknown > 0 || trouble,
    };
  };

  if (recipientSkip) return finish(ZERO, recipientSkip);

  const built = await deps.build(kind, anchor);
  if (!built.ok) {
    await deps.reportError({ scope: SCOPE, error: new Error(built.message), metadata: { alert_key: key } });
    return { status: 500, body: { error: "failed" }, failed: true };
  }
  if (built.kind === "too_early") {
    return finish(ZERO, "that period starts before Patient Sources' first date (1 December 2023)", built.period);
  }

  const c: Counts = { ...ZERO, recipients: alert.emails.length };
  let sendSkipReason: string | null = null;

  for (const to of alert.emails) {
    const recipient = to.trim().toLowerCase();
    const claim = await deps.store.claim(key, built.period.from, built.period.to, recipient, includeUnknown);
    if (claim.error) {
      c.failed += 1;
      trouble = true;
      await deps.reportError({ scope: SCOPE, error: new Error(`claim: ${claim.error}`), metadata: { alert_key: key } });
      continue;
    }
    if (claim.attempts === null) {
      // Not claimed: say why, because "unknown" must keep the monitor red until an operator looks.
      const status = await deps.store.statusOf(key, built.period.from, recipient);
      if (status === "sent") c.alreadySent += 1;
      else if (status === "unknown") c.unknown += 1;
      else c.inFlight += 1;
      continue;
    }

    let result: SendResult;
    try {
      result = await deps.send({
        to,
        subject: built.subject,
        text: built.text,
        html: built.html,
        idempotencyKey: `${key}:${built.period.from}:${recipient}:${claim.attempts}`,
      });
    } catch (e) {
      result = { ok: false, kind: "error", error: e instanceof Error ? e.message : "unknown", definite: false };
    }

    let recordError: string | null;
    if (result.ok) {
      c.sent += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "sent", providerId: result.id });
    } else if (result.kind === "skipped") {
      c.failed += 1;
      c.skippedSends += 1;
      sendSkipReason = sendSkipReason ?? result.reason;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "failed", error: result.reason });
    } else if (result.definite === true) {
      c.failed += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "failed", error: result.error });
    } else {
      c.unknown += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "unknown", error: result.error });
    }
    if (recordError) {
      trouble = true;
      await deps.reportError({ scope: SCOPE, error: new Error(`record: ${recordError}`), metadata: { alert_key: key } });
    }
  }

  return finish(c, deliveryNote(c, sendSkipReason), built.period);
}

/** The real wiring, called by the two cron routes AFTER CRON_SECRET and query validation. */
export async function runDigestCron(
  kind: DigestKind,
  params: { periodFrom: string | null; includeUnknown: boolean },
  markFailed: () => void,
): Promise<Response> {
  const admin = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph";
  try {
    const result = await runPatientSourcesDigest(
      {
        now: () => new Date(),
        resolveRecipients: (k) => resolveStaffAlertRecipients(k, admin),
        build: (k, anchor) => buildPatientSourcesDigestEmail(admin, k, anchor, appUrl),
        store: supabaseDigestStore(admin),
        send: sendEmail,
        audit,
        reportError,
      },
      { kind, periodFrom: params.periodFrom, includeUnknown: params.includeUnknown },
    );
    if (result.failed) markFailed();
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    await reportError({ scope: `cron/patient-sources-${kind === "week" ? "weekly" : "monthly"}`, error });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
