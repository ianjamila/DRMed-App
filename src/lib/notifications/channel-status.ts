// Whether email (Resend) and SMS (Semaphore) can actually send here — the ONE
// check sendEmail / sendSms run before every send, also read by the Email
// Alerts page and Result Follow-ups so staff can see "not set up" before a
// notice fails. Reads only whether settings are present; never returns a value.
// No "server-only": it is pure over the env it is given (the default is
// process.env, which only has these keys on the server anyway).
// Never import it into a client component: there process.env holds only
// NEXT_PUBLIC_* values, so every channel would wrongly read as not set up.

export type ChannelStatus =
  | { ready: true }
  // not_live: sending is switched off in this environment (not production,
  // and NOTIFICATIONS_LIVE isn't "true") — M6: dev must never message patients.
  // not_configured: live, but the provider's key or sender is missing.
  | { ready: false; code: "not_live" | "not_configured"; reason: string };

type Env = Record<string, string | undefined>;

export function notificationsLive(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.NOTIFICATIONS_LIVE === "true";
}

const NOT_LIVE = {
  ready: false,
  code: "not_live",
  reason: "NOTIFICATIONS_LIVE not enabled in this environment",
} as const;

export function emailStatus(env: Env = process.env): ChannelStatus {
  if (!notificationsLive(env)) return NOT_LIVE;
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("your_resend") || !env.RESEND_FROM_EMAIL) {
    return { ready: false, code: "not_configured", reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" };
  }
  return { ready: true };
}

export function smsStatus(env: Env = process.env): ChannelStatus {
  if (!notificationsLive(env)) return NOT_LIVE;
  const apiKey = env.SEMAPHORE_API_KEY;
  if (!apiKey || apiKey.includes("your_semaphore") || !env.SEMAPHORE_SENDER_NAME) {
    return { ready: false, code: "not_configured", reason: "SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured" };
  }
  return { ready: true };
}

/** The admin-facing line for one channel on the Email Alerts page. */
export function channelStatusText(channel: "email" | "sms", s: ChannelStatus): string {
  if (s.ready) return "Ready";
  if (s.code === "not_live") return "Switched off here — this isn't the live site, so nothing is sent.";
  return channel === "email"
    ? "Not set up — the Resend API key or sender address is missing in the site settings (Vercel)."
    : "Not set up — the Semaphore API key or sender name is missing in the site settings (Vercel).";
}

/**
 * Reception's note on Result Follow-ups when patient notices can't go out on
 * some channel, or null when both can.
 */
export function patientNoticeSetupNote(email: ChannelStatus, sms: ChannelStatus): string | null {
  if (email.ready && sms.ready) return null;
  if (!email.ready && !sms.ready) {
    return "Email and text notices aren't set up here, so \"Let the patient know\" can't reach anyone — call patients instead, and tell an admin.";
  }
  return email.ready
    ? "Text-message notices aren't set up here — patients with only a mobile number won't get one. Tell an admin."
    : "Email notices aren't set up here — patients with only an email address won't get one. Tell an admin.";
}
