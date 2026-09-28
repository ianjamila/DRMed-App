import { describe, expect, it } from "vitest";
import {
  channelStatusText,
  emailStatus,
  notificationsLive,
  patientNoticeSetupNote,
  smsStatus,
} from "./channel-status";

// The one check sendEmail / sendSms run before every send, also shown on the
// Email Alerts page and Result Follow-ups. Its skip reasons are the exact
// strings describeSendFailure (notify-corrected.ts) and 0188's notify_problem
// classify, so they are pinned verbatim here.

const LIVE = { VERCEL_ENV: "production" };
const EMAIL_KEYS = { RESEND_API_KEY: "re_live_secret_value", RESEND_FROM_EMAIL: "clinic@drmed.ph" };
const SMS_KEYS = { SEMAPHORE_API_KEY: "sem_live_secret_value", SEMAPHORE_SENDER_NAME: "DRMED" };

describe("notificationsLive", () => {
  it("is on in production or with an explicit local opt-in, off otherwise", () => {
    expect(notificationsLive({ VERCEL_ENV: "production" })).toBe(true);
    expect(notificationsLive({ NOTIFICATIONS_LIVE: "true" })).toBe(true);
    expect(notificationsLive({ VERCEL_ENV: "preview" })).toBe(false);
    expect(notificationsLive({})).toBe(false);
  });
});

describe("emailStatus / smsStatus", () => {
  it("are ready only when live and both settings are present", () => {
    expect(emailStatus({ ...LIVE, ...EMAIL_KEYS })).toEqual({ ready: true });
    expect(smsStatus({ ...LIVE, ...SMS_KEYS })).toEqual({ ready: true });
  });

  it("say not live first, with the sender's exact skip reason", () => {
    const s = { ready: false, code: "not_live", reason: "NOTIFICATIONS_LIVE not enabled in this environment" };
    expect(emailStatus({ ...EMAIL_KEYS })).toEqual(s);
    expect(smsStatus({ ...SMS_KEYS })).toEqual(s);
  });

  it("treat a missing key, a missing sender or an .env.example placeholder as not configured", () => {
    const email = { ready: false, code: "not_configured", reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" };
    expect(emailStatus({ ...LIVE, RESEND_FROM_EMAIL: "x@y" })).toEqual(email);
    expect(emailStatus({ ...LIVE, RESEND_API_KEY: "k" })).toEqual(email);
    expect(emailStatus({ ...LIVE, RESEND_API_KEY: "your_resend_api_key", RESEND_FROM_EMAIL: "x@y" })).toEqual(email);
    const sms = { ready: false, code: "not_configured", reason: "SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured" };
    expect(smsStatus({ ...LIVE, SEMAPHORE_SENDER_NAME: "DRMED" })).toEqual(sms);
    expect(smsStatus({ ...LIVE, SEMAPHORE_API_KEY: "your_semaphore_key", SEMAPHORE_SENDER_NAME: "DRMED" })).toEqual(sms);
  });

  it("never carry a setting's value", () => {
    const all = JSON.stringify([
      emailStatus({ ...LIVE, ...EMAIL_KEYS }),
      smsStatus({ ...LIVE, ...SMS_KEYS }),
      emailStatus({ ...LIVE, RESEND_API_KEY: "re_live_secret_value" }),
      smsStatus({ ...LIVE, SEMAPHORE_API_KEY: "sem_live_secret_value" }),
    ]);
    expect(all).not.toMatch(/secret_value|clinic@drmed\.ph|DRMED"/);
  });
});

describe("what staff read", () => {
  const ready = { ready: true } as const;
  const notLive = { ready: false, code: "not_live", reason: "x" } as const;
  const missing = { ready: false, code: "not_configured", reason: "x" } as const;

  it("the Email Alerts line per channel", () => {
    expect(channelStatusText("email", ready)).toBe("Ready");
    expect(channelStatusText("sms", notLive)).toMatch(/^Switched off here/);
    expect(channelStatusText("email", missing)).toMatch(/Resend API key or sender address/);
    expect(channelStatusText("sms", missing)).toMatch(/Semaphore API key or sender name/);
  });

  it("reception's Result Follow-ups note names what can't go out, or nothing when both can", () => {
    expect(patientNoticeSetupNote(ready, ready)).toBeNull();
    expect(patientNoticeSetupNote(missing, notLive)).toMatch(/^Email and text notices aren't set up/);
    expect(patientNoticeSetupNote(ready, missing)).toMatch(/^Text-message notices aren't set up/);
    expect(patientNoticeSetupNote(notLive, ready)).toMatch(/^Email notices aren't set up/);
  });
});
