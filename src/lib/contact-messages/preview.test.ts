import { describe, it, expect } from "vitest";
import { messagePreview, MESSAGE_PREVIEW_CHARS } from "@/lib/contact-messages/preview";

describe("messagePreview", () => {
  it("returns a short message whole and not truncated", () => {
    expect(messagePreview("Do you do home service?")).toEqual({
      text: "Do you do home service?",
      truncated: false,
    });
  });

  it("collapses line breaks so a multi-line message stays one row", () => {
    expect(messagePreview("Hi,\n\nHow much is a CBC?\r\nThanks")).toEqual({
      text: "Hi, How much is a CBC? Thanks",
      truncated: false,
    });
  });

  it("flags a long message as truncated and ends it with an ellipsis", () => {
    const long = "word ".repeat(100);
    const out = messagePreview(long);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_CHARS + 1);
  });

  it("does not flag a message exactly at the limit", () => {
    const exact = "x".repeat(MESSAGE_PREVIEW_CHARS);
    expect(messagePreview(exact)).toEqual({ text: exact, truncated: false });
  });
});
