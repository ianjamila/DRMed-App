import { describe, expect, it } from "vitest";
import { REPLY_BODY_MAX, REPLY_SMS_MAX } from "./labels";
import {
  ReplyInputSchema,
  buildEmailReply,
  buildSmsReplyBody,
  replyTemplates,
  smsSegmentCount,
} from "./reply-content";

describe("smsSegmentCount", () => {
  it("is 0 for empty text", () => {
    expect(smsSegmentCount("")).toBe(0);
  });

  it("is 1 for text at or under 160 characters", () => {
    expect(smsSegmentCount("a")).toBe(1);
    expect(smsSegmentCount("a".repeat(160))).toBe(1);
  });

  it("rolls over to a second segment at 161 characters", () => {
    expect(smsSegmentCount("a".repeat(161))).toBe(2);
  });

  it("matches REPLY_SMS_MAX's segment count (3)", () => {
    expect(smsSegmentCount("a".repeat(REPLY_SMS_MAX))).toBe(3);
  });
});

describe("buildSmsReplyBody", () => {
  it("appends the sign-off when it fits", () => {
    const result = buildSmsReplyBody("Thanks for reaching out!");
    expect(result).toBe("Thanks for reaching out! – DR Med");
    expect(result.length).toBeLessThanOrEqual(REPLY_SMS_MAX);
  });

  it("trims the staff text before measuring", () => {
    const result = buildSmsReplyBody("  Hi there  ");
    expect(result.startsWith("Hi there")).toBe(true);
    expect(result.startsWith(" ")).toBe(false);
  });

  it("never exceeds REPLY_SMS_MAX, even for text right at the cap", () => {
    const staffText = "a".repeat(REPLY_SMS_MAX);
    const result = buildSmsReplyBody(staffText);
    expect(result.length).toBeLessThanOrEqual(REPLY_SMS_MAX);
    // Too long for the sign-off to fit — falls back to the bare text.
    expect(result).toBe(staffText);
  });

  it("never exceeds REPLY_SMS_MAX for text a few characters under the cap", () => {
    // Long enough that the text itself fits but text+signoff does not.
    const staffText = "a".repeat(REPLY_SMS_MAX - 3);
    const result = buildSmsReplyBody(staffText);
    expect(result.length).toBeLessThanOrEqual(REPLY_SMS_MAX);
  });

  it("stays within the cap across a sweep of lengths near the boundary", () => {
    for (let len = REPLY_SMS_MAX - 20; len <= REPLY_SMS_MAX; len++) {
      const result = buildSmsReplyBody("a".repeat(len));
      expect(result.length).toBeLessThanOrEqual(REPLY_SMS_MAX);
    }
  });
});

describe("buildEmailReply", () => {
  it("escapes HTML in the staff text", () => {
    const content = buildEmailReply({
      firstName: "Juan",
      subject: "Laboratory Tests",
      staffText: "Please bring your <script>alert(1)</script> ID & receipt.",
    });
    expect(content.html).not.toContain("<script>alert(1)</script>");
    expect(content.html).toContain("&lt;script&gt;");
    expect(content.html).toContain("&amp;");
    // The plain-text part is not HTML-escaped.
    expect(content.text).toContain("<script>alert(1)</script>");
  });

  it("uses Re: <subject> when a subject exists, else a generic subject", () => {
    expect(buildEmailReply({ firstName: "Juan", subject: "Laboratory Tests", staffText: "Hi" }).subject).toBe(
      "Re: Laboratory Tests",
    );
    expect(buildEmailReply({ firstName: "Juan", subject: null, staffText: "Hi" }).subject).toBe(
      "Re: your message to DR Med",
    );
    expect(buildEmailReply({ firstName: "Juan", subject: "   ", staffText: "Hi" }).subject).toBe(
      "Re: your message to DR Med",
    );
  });

  it("greets by first name and preserves paragraphs", () => {
    const content = buildEmailReply({
      firstName: "Maria",
      subject: null,
      staffText: "First paragraph.\n\nSecond paragraph.",
    });
    expect(content.text).toContain("Hi Maria,");
    expect(content.html).toContain("Hi Maria,");
    expect(content.text).toContain("First paragraph.");
    expect(content.text).toContain("Second paragraph.");
    expect(content.html).toContain("First paragraph.");
    expect(content.html).toContain("Second paragraph.");
  });

  it("contains no field for, and therefore no trace of, an original message", () => {
    // Structural guarantee: BuildEmailReplyInput has no "message"/"originalMessage"
    // field, so there is nothing for buildEmailReply to leak. Sanity-check with a
    // staffText that does NOT mention any original-message content.
    const content = buildEmailReply({
      firstName: "Juan",
      subject: "Doctor's Consultation",
      staffText: "Thanks for reaching out — we'll call you shortly.",
    });
    expect(content.text).not.toMatch(/you (wrote|said)/i);
    expect(content.html).not.toMatch(/you (wrote|said)/i);
  });

  it("includes the clinic name and phone as a sign-off", () => {
    const content = buildEmailReply({ firstName: "Juan", subject: null, staffText: "Hi" });
    expect(content.text).toContain("DRMed Clinic and Laboratory");
    expect(content.text).toContain("0916 604 3208");
    expect(content.html).toContain("0916 604 3208");
  });
});

describe("ReplyInputSchema", () => {
  const base = { messageId: "11111111-1111-4111-8111-111111111111", channel: "email" as const };

  it("accepts a valid email reply", () => {
    const result = ReplyInputSchema.safeParse({ ...base, body: "Thanks for reaching out." });
    expect(result.success).toBe(true);
  });

  it("trims the body", () => {
    const result = ReplyInputSchema.safeParse({ ...base, body: "  Hi there  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.body).toBe("Hi there");
  });

  it("rejects an empty or whitespace-only body", () => {
    expect(ReplyInputSchema.safeParse({ ...base, body: "" }).success).toBe(false);
    expect(ReplyInputSchema.safeParse({ ...base, body: "   " }).success).toBe(false);
  });

  it("rejects a body over REPLY_BODY_MAX for email", () => {
    expect(ReplyInputSchema.safeParse({ ...base, body: "a".repeat(REPLY_BODY_MAX + 1) }).success).toBe(false);
    expect(ReplyInputSchema.safeParse({ ...base, body: "a".repeat(REPLY_BODY_MAX) }).success).toBe(true);
  });

  it("rejects a non-uuid messageId", () => {
    expect(ReplyInputSchema.safeParse({ ...base, messageId: "not-a-uuid", body: "Hi" }).success).toBe(false);
  });

  it("rejects an unknown channel", () => {
    expect(ReplyInputSchema.safeParse({ ...base, channel: "carrier-pigeon", body: "Hi" }).success).toBe(false);
  });

  it("allows an SMS body up to REPLY_SMS_MAX but rejects beyond it, even though it is under REPLY_BODY_MAX", () => {
    const smsBase = { ...base, channel: "sms" as const };
    expect(ReplyInputSchema.safeParse({ ...smsBase, body: "a".repeat(REPLY_SMS_MAX) }).success).toBe(true);
    expect(ReplyInputSchema.safeParse({ ...smsBase, body: "a".repeat(REPLY_SMS_MAX + 1) }).success).toBe(false);
  });

  it("allows an email body between REPLY_SMS_MAX and REPLY_BODY_MAX", () => {
    const body = "a".repeat(REPLY_SMS_MAX + 50);
    expect(ReplyInputSchema.safeParse({ ...base, channel: "email", body }).success).toBe(true);
  });
});

describe("replyTemplates", () => {
  it("returns exactly the templates the reply panel offers, each filled with the first name", () => {
    const templates = replyTemplates("Juan");
    expect(templates.length).toBeGreaterThanOrEqual(2);
    expect(templates.length).toBeLessThanOrEqual(3);
    for (const t of templates) {
      expect(t.body).toContain("Juan");
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("has stable, unique template ids", () => {
    const ids = replyTemplates("Maria").map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
