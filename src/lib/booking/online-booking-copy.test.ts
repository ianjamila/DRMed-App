import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTACT } from "@/lib/marketing/site";
import {
  BOOKING_PAUSED_ERROR,
  PAUSED_MESSAGE_MAX,
  normalizePausedMessage,
} from "./online-booking-copy";

describe("normalizePausedMessage", () => {
  it("treats null, undefined, empty and whitespace-only as no note", () => {
    for (const raw of [null, undefined, "", "   ", "\n\t "]) {
      expect(normalizePausedMessage(raw)).toEqual({ ok: true, message: null });
    }
  });

  it("trims surrounding whitespace but keeps inner line breaks", () => {
    expect(normalizePausedMessage("  Back on 1 October.\nThank you!  ")).toEqual({
      ok: true,
      message: "Back on 1 October.\nThank you!",
    });
  });

  it("accepts a note of exactly the limit and rejects one character over", () => {
    expect(normalizePausedMessage("a".repeat(PAUSED_MESSAGE_MAX))).toEqual({
      ok: true,
      message: "a".repeat(PAUSED_MESSAGE_MAX),
    });
    const over = normalizePausedMessage("a".repeat(PAUSED_MESSAGE_MAX + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(PAUSED_MESSAGE_MAX));
  });

  it("measures the limit after trimming", () => {
    const padded = `   ${"a".repeat(PAUSED_MESSAGE_MAX)}   `;
    expect(normalizePausedMessage(padded).ok).toBe(true);
  });
});

describe("BOOKING_PAUSED_ERROR", () => {
  it("tells the patient how to reach reception", () => {
    expect(BOOKING_PAUSED_ERROR).toContain(CONTACT.phone.mobile);
    expect(BOOKING_PAUSED_ERROR).toContain(CONTACT.phone.landline);
  });
});

describe("booking_settings migration parity", () => {
  it("the paused_message CHECK in 0153 uses the same limit as PAUSED_MESSAGE_MAX", () => {
    const sql = readFileSync(
      join(__dirname, "../../../supabase/migrations/0153_booking_settings.sql"),
      "utf8",
    );
    const m = /char_length\(paused_message\)\s+between\s+1\s+and\s+(\d+)/i.exec(sql);
    expect(m, "0153 must bound paused_message with char_length(...) between 1 and N").not.toBeNull();
    expect(Number(m![1])).toBe(PAUSED_MESSAGE_MAX);
  });
});
