import { describe, expect, it } from "vitest";
import { normaliseAlertSentMetadata } from "./alert-last-sent";

describe("normaliseAlertSentMetadata", () => {
  it("reads the website_message shape (contact_message.alert_sent): {recipients, sent, failed, skipped?}", () => {
    expect(normaliseAlertSentMetadata({ recipients: 5, sent: 4, failed: 1 })).toEqual({
      recipients: 5,
      sent: 4,
      failed: 1,
      skipped: null,
    });
    expect(
      normaliseAlertSentMetadata({ recipients: 0, sent: 0, failed: 0, skipped: "turned off in Email Alerts" }),
    ).toEqual({ recipients: 0, sent: 0, failed: 0, skipped: "turned off in Email Alerts" });
  });

  it("reads the template_health shape (system.template_health.alert_sent): {recipients, emailed, skipped?} — sent falls back to emailed", () => {
    expect(normaliseAlertSentMetadata({ mode: "daily", findings: 2, recipients: 3, emailed: 3 })).toEqual({
      recipients: 3,
      sent: 3,
      failed: 0,
      skipped: null,
    });
  });

  it("reads the dedup_digest shape (system.dedup_digest.sent): {recipients, emailed, skipped?}", () => {
    expect(
      normaliseAlertSentMetadata({ candidates: 7, by_tier: { probable: 7 }, recipients: 2, emailed: 2 }),
    ).toEqual({ recipients: 2, sent: 2, failed: 0, skipped: null });
  });

  it("prefers an explicit sent over emailed when a shape somehow carries both", () => {
    expect(normaliseAlertSentMetadata({ recipients: 1, sent: 1, emailed: 0 })).toEqual({
      recipients: 1,
      sent: 1,
      failed: 0,
      skipped: null,
    });
  });

  it("defaults every field for null, non-object, or empty metadata", () => {
    expect(normaliseAlertSentMetadata(null)).toEqual({ recipients: 0, sent: 0, failed: 0, skipped: null });
    expect(normaliseAlertSentMetadata(undefined)).toEqual({ recipients: 0, sent: 0, failed: 0, skipped: null });
    expect(normaliseAlertSentMetadata("not an object")).toEqual({
      recipients: 0,
      sent: 0,
      failed: 0,
      skipped: null,
    });
    expect(normaliseAlertSentMetadata({})).toEqual({ recipients: 0, sent: 0, failed: 0, skipped: null });
  });

  it("ignores non-numeric / non-string junk rather than throwing", () => {
    expect(
      normaliseAlertSentMetadata({ recipients: "5", sent: null, skipped: 42 }),
    ).toEqual({ recipients: 0, sent: 0, failed: 0, skipped: null });
  });
});
