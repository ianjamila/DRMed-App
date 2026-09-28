import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps a staff path", () => {
    expect(safeRedirectPath("/staff/visits/queue?stage=processing")).toBe(
      "/staff/visits/queue?stage=processing",
    );
  });

  it("keeps the bare staff root", () => {
    expect(safeRedirectPath("/staff")).toBe("/staff");
  });

  // eaglewatch's callback uses `next.startsWith("/")`, which lets this through:
  // browsers read "//host" as scheme-relative and navigate off-site.
  it("rejects a scheme-relative URL", () => {
    expect(safeRedirectPath("//evil.example.com/staff")).toBe("/staff");
  });

  it("rejects a backslash variant", () => {
    expect(safeRedirectPath("/\\evil.example.com")).toBe("/staff");
  });

  it("rejects an absolute URL", () => {
    expect(safeRedirectPath("https://evil.example.com/staff")).toBe("/staff");
  });

  it("rejects traversal out of /staff", () => {
    expect(safeRedirectPath("/staff/../../etc")).toBe("/staff");
  });

  it("rejects a path outside /staff", () => {
    expect(safeRedirectPath("/portal/results")).toBe("/staff");
  });

  it("rejects a prefix that only looks like /staff", () => {
    expect(safeRedirectPath("/staffing-agency")).toBe("/staff");
  });

  it("rejects control characters", () => {
    expect(safeRedirectPath("/staff/a\nb")).toBe("/staff");
  });

  // DEL sits above the C0 range, so a blocklist that stops at U+001F misses it.
  it("rejects DEL", () => {
    expect(safeRedirectPath(`/staff/a${String.fromCharCode(0x7f)}b`)).toBe(
      "/staff",
    );
  });

  it.each([null, undefined, ""])("falls back for %s", (value) => {
    expect(safeRedirectPath(value)).toBe("/staff");
  });

  // Percent-encoded ".." segments pass the raw-string ".." check above
  // (the literal two dots never appear), but a browser (and `new URL`)
  // decodes and resolves them before navigating — so "/staff/%2e%2e/patients"
  // lands outside the staff area even though it started inside it.
  it.each([
    "/staff/%2e%2e/patients",
    "/staff/%2E%2e/x",
    "/staff/.%2e/x",
    "/staff/%2e./x",
    "/staff/foo/%2e%2e/%2e%2e/bar",
  ])("rejects an encoded traversal segment: %s", (value) => {
    expect(safeRedirectPath(value)).toBe("/staff");
  });

  it("keeps an ordinary path with an encoded query value", () => {
    expect(safeRedirectPath("/staff/patients?q=a%2Fb")).toBe(
      "/staff/patients?q=a%2Fb",
    );
  });

  it("keeps an ordinary path with a fragment", () => {
    expect(safeRedirectPath("/staff/visits/123#top")).toBe(
      "/staff/visits/123#top",
    );
  });
});
