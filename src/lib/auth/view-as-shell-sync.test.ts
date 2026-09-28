import { describe, expect, it } from "vitest";
import { checkViewAsShell, shellIsStale } from "./view-as-shell-sync";

const ACTIVE = { role: "reception" as const, until: "2026-09-28T08:00:00.000Z" };

describe("shellIsStale", () => {
  it("is false when the server agrees (same instant, any precision)", () => {
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T08:00:00.000Z" })).toBe(false);
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T08:00:00+00:00" })).toBe(false);
    expect(shellIsStale(null, { role: null, until: null })).toBe(false);
  });
  it("is true on any difference or a malformed answer", () => {
    expect(shellIsStale(ACTIVE, { role: "medtech", until: ACTIVE.until })).toBe(true);
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T09:00:00.000Z" })).toBe(true);
    expect(shellIsStale(ACTIVE, { role: null, until: null })).toBe(true);
    expect(shellIsStale(null, ACTIVE)).toBe(true);
    expect(shellIsStale(null, "nope")).toBe(true);
    expect(shellIsStale(null, null)).toBe(true);
  });
});

function fakeFetch(body: unknown, init: { ok?: boolean; type?: string; throws?: unknown } = {}) {
  return (async () => {
    if (init.throws) throw init.throws;
    return {
      ok: init.ok ?? true,
      headers: new Headers({ "content-type": init.type ?? "application/json" }),
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

describe("checkViewAsShell", () => {
  it("asks for a refresh only on mismatch", async () => {
    expect(await checkViewAsShell(ACTIVE, fakeFetch(ACTIVE))).toBe(false);
    expect(await checkViewAsShell(ACTIVE, fakeFetch({ role: null, until: null }))).toBe(true);
  });
  it("refreshes when the answer is not usable JSON (e.g. redirected to login)", async () => {
    expect(await checkViewAsShell(null, fakeFetch("<html>", { type: "text/html" }))).toBe(true);
    expect(await checkViewAsShell(null, fakeFetch({}, { ok: false }))).toBe(true);
    expect(await checkViewAsShell(null, fakeFetch(null, { throws: new TypeError("net") }))).toBe(true);
  });
  it("does nothing when aborted", async () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(await checkViewAsShell(null, fakeFetch(null, { throws: abort }))).toBe(false);
  });
});
