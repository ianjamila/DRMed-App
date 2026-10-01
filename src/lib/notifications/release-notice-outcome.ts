// What actually happened to the patient's "result ready" notice, so callers
// (the visit bar's "already notified" line, the result.released audit row)
// record the real outcome instead of guessing from "something was announced".
// Pure — no server-only imports.

// "retrying": the outbox (0210) could not finish the send on the first try and
// the sweeper will retry it automatically — nothing has gone out yet, and it is
// not a failure the operator has to act on.
export type NoticeStatus = "sent" | "skipped" | "failed" | "retrying";

export interface ReleaseNoticeOutcome {
  status: NoticeStatus;
  /** Channels that delivered (email first). */
  channels: Array<"email" | "sms">;
  /** Plain-language why, for skipped / failed; null when sent. */
  reason: string | null;
}

export function noticeSkipped(reason: string): ReleaseNoticeOutcome {
  return { status: "skipped", channels: [], reason };
}

export const NOTICE_RETRY_REASON = "will retry automatically";

export function noticeRetrying(): ReleaseNoticeOutcome {
  return { status: "retrying", channels: [], reason: NOTICE_RETRY_REASON };
}

export function noticeFromChannels(
  sms: { ok: boolean; kind?: string },
  email: { ok: boolean; kind?: string },
): ReleaseNoticeOutcome {
  const channels: Array<"email" | "sms"> = [];
  if (email.ok) channels.push("email");
  if (sms.ok) channels.push("sms");
  if (channels.length > 0) return { status: "sent", channels, reason: null };
  if (sms.kind === "error" || email.kind === "error") {
    return { status: "failed", channels: [], reason: "sending failed" };
  }
  return { status: "skipped", channels: [], reason: "no email or phone on file" };
}

/**
 * The notice half of a `result.released` audit row. `patient_notified` means a
 * message was actually SENT on at least one channel; `patient_notice` says what
 * happened otherwise (null when no notice was attempted).
 */
export function noticeAuditMeta(notice: ReleaseNoticeOutcome | null | undefined): {
  patient_notified: boolean;
  patient_notice: { status: NoticeStatus; channels: Array<"email" | "sms">; reason: string | null } | null;
} {
  return {
    patient_notified: notice?.status === "sent",
    patient_notice: notice
      ? { status: notice.status, channels: [...notice.channels], reason: notice.reason }
      : null,
  };
}
