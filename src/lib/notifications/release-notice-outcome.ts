// What actually happened to the patient's "result ready" notice, so callers
// (the visit bar's "already notified" line, the result.released audit row)
// record the real outcome instead of guessing from "something was announced".
// Pure — no server-only imports.

export type NoticeStatus = "sent" | "skipped" | "failed";

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
