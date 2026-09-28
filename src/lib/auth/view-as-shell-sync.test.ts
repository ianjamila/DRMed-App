import { describe, expect, it } from "vitest";
import { checkViewAsShell, shellIsStale, type ViewAsShellState } from "./view-as-shell-sync";

const OVERRIDE = { role: "reception" as const, until: "2026-09-28T08:00:00.000Z" };
const ACTIVE: ViewAsShellState = { actualRole: "admin", viewAs: OVERRIDE };
const NONE: ViewAsShellState = { actualRole: "admin", viewAs: null };
const ANSWER_ACTIVE = { actual_role: "admin", role: "reception", until: "2026-09-28T08:00:00.000Z" };
const ANSWER_NONE = { actual_role: "admin", role: null, until: null };

describe("shellIsStale", () => {
  it("is false when the server agrees (same instant, any precision)", () => {
    expect(shellIsStale(ACTIVE, ANSWER_ACTIVE)).toBe(false);
    expect(shellIsStale(ACTIVE, { actual_role: "admin", role: "reception", until: "2026-09-28T08:00:00+00:00" })).toBe(
      false,
    );
    expect(shellIsStale(NONE, ANSWER_NONE)).toBe(false);
  });
  it("is true on any difference or a malformed answer", () => {
    expect(shellIsStale(ACTIVE, { actual_role: "admin", role: "medtech", until: OVERRIDE.until })).toBe(true);
    expect(
      shellIsStale(ACTIVE, { actual_role: "admin", role: "reception", until: "2026-09-28T09:00:00.000Z" }),
    ).toBe(true);
    expect(shellIsStale(ACTIVE, ANSWER_NONE)).toBe(true);
    expect(shellIsStale(NONE, ANSWER_ACTIVE)).toBe(true);
    expect(shellIsStale(NONE, "nope")).toBe(true);
    expect(shellIsStale(NONE, null)).toBe(true);
  });
  it("actual role changed from admin to reception with no override → stale", () => {
    expect(shellIsStale(NONE, { actual_role: "reception", role: null, until: null })).toBe(true);
  });
  it("same actual role + same override → not stale", () => {
    expect(shellIsStale(ACTIVE, ANSWER_ACTIVE)).toBe(false);
  });
  it("missing actual_role in answer → stale", () => {
    expect(shellIsStale(NONE, { role: null, until: null })).toBe(true);
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
    expect(await checkViewAsShell(ACTIVE, fakeFetch(ANSWER_ACTIVE))).toBe(false);
    expect(await checkViewAsShell(ACTIVE, fakeFetch(ANSWER_NONE))).toBe(true);
  });
  it("refreshes when the answer is not usable JSON (e.g. redirected to login)", async () => {
    expect(await checkViewAsShell(NONE, fakeFetch("<html>", { type: "text/html" }))).toBe(true);
    expect(await checkViewAsShell(NONE, fakeFetch({}, { ok: false }))).toBe(true);
    expect(await checkViewAsShell(NONE, fakeFetch(null, { throws: new TypeError("net") }))).toBe(true);
  });
  it("does nothing when aborted", async () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(await checkViewAsShell(NONE, fakeFetch(null, { throws: abort }))).toBe(false);
  });
});
