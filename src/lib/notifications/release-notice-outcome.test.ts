import { describe, expect, it } from "vitest";
import { noticeAuditMeta, noticeFromChannels, noticeSkipped } from "./release-notice-outcome";

const ok = { ok: true as const };
const err = { ok: false as const, kind: "error" as const };
const skip = { ok: false as const, kind: "skipped" as const };

describe("noticeSkipped", () => {
  it("carries the reason and no channels", () => {
    expect(noticeSkipped("sample visit")).toEqual({ status: "skipped", channels: [], reason: "sample visit" });
  });
});

describe("noticeFromChannels", () => {
  it("email only is sent", () => {
    expect(noticeFromChannels(skip, ok)).toEqual({ status: "sent", channels: ["email"], reason: null });
  });
  it("sms only is sent", () => {
    expect(noticeFromChannels(ok, skip)).toEqual({ status: "sent", channels: ["sms"], reason: null });
  });
  it("both lists email first", () => {
    expect(noticeFromChannels(ok, ok).channels).toEqual(["email", "sms"]);
  });
  it("one channel delivered and the other errored is still sent", () => {
    expect(noticeFromChannels(err, ok)).toEqual({ status: "sent", channels: ["email"], reason: null });
  });
  it("an error with nothing delivered is failed", () => {
    expect(noticeFromChannels(skip, err)).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(noticeFromChannels(err, skip).status).toBe("failed");
    expect(noticeFromChannels(err, err).status).toBe("failed");
  });
  it("nothing delivered and nothing errored is skipped", () => {
    expect(noticeFromChannels(skip, skip)).toEqual({
      status: "skipped",
      channels: [],
      reason: "no email or phone on file",
    });
  });
});

describe("noticeAuditMeta", () => {
  it("sent: patient_notified true with the channels", () => {
    expect(noticeAuditMeta({ status: "sent", channels: ["email", "sms"], reason: null })).toEqual({
      patient_notified: true,
      patient_notice: { status: "sent", channels: ["email", "sms"], reason: null },
    });
  });
  it("skipped and failed are not notified and keep the reason", () => {
    expect(noticeAuditMeta(noticeSkipped("sample visit"))).toEqual({
      patient_notified: false,
      patient_notice: { status: "skipped", channels: [], reason: "sample visit" },
    });
    expect(noticeAuditMeta({ status: "failed", channels: [], reason: "sending failed" }).patient_notified).toBe(false);
  });
  it("no notice attempted: false and null", () => {
    expect(noticeAuditMeta(null)).toEqual({ patient_notified: false, patient_notice: null });
    expect(noticeAuditMeta(undefined)).toEqual({ patient_notified: false, patient_notice: null });
  });
});
