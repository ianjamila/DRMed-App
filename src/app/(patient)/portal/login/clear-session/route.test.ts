import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This route imports "server-only" (transitively, via require-patient.ts /
// patient-session-cookies.ts) so it can't be exercised directly under
// vitest (CLAUDE.md: modules under test must not import server-only) — a
// source-pattern test instead. Proves the conditional Opus's re-review of
// a3f42261 asked for: clearPatientSessionCookie() must only run once BOTH
// "there is a signed cookie" and "it is not active" are known, never
// unconditionally on every hit.

const SRC = readFileSync(
  join(
    process.cwd(),
    "src/app/(patient)/portal/login/clear-session/route.ts",
  ),
  "utf8",
);

describe("clear-session route only clears a signed, inactive cookie", () => {
  it("checks for a signed cookie before doing anything else", () => {
    expect(SRC).toMatch(/const hasCookie = await hasSignedPatientCookie\(\);/);
  });

  it("bails to /portal/login without clearing when there is no cookie", () => {
    const noCookieBlock = /if \(!hasCookie\) \{\s*redirect\("\/portal\/login"\);\s*\}/;
    expect(SRC).toMatch(noCookieBlock);
  });

  it("re-checks activity and leaves an ACTIVE session's cookie alone", () => {
    const activeBlock = /if \(active\) \{\s*redirect\("\/portal"\);\s*\}/;
    expect(SRC).toMatch(activeBlock);
  });

  it("clears the cookie only after both checks, and only that once", () => {
    const clearCalls = SRC.match(/clearPatientSessionCookie\(\)/g) ?? [];
    expect(clearCalls, "clearPatientSessionCookie() must appear exactly once").toHaveLength(1);

    // Ordering: the no-cookie redirect, then the active-session redirect,
    // then the clear call, then the final redirect. Each check must run
    // (and be able to return) before the clear call is reached.
    const iHasCookieCheck = SRC.indexOf("if (!hasCookie)");
    const iActiveCheck = SRC.indexOf("if (active)");
    const iClear = SRC.indexOf("clearPatientSessionCookie()");
    const iFinalRedirect = SRC.lastIndexOf('redirect("/portal/login")');

    expect(iHasCookieCheck).toBeGreaterThan(-1);
    expect(iActiveCheck).toBeGreaterThan(iHasCookieCheck);
    expect(iClear).toBeGreaterThan(iActiveCheck);
    expect(iFinalRedirect).toBeGreaterThan(iClear);
  });

  it("never calls clearPatientSessionCookie unconditionally at the top of GET", () => {
    const getBody = SRC.slice(SRC.indexOf("export async function GET"));
    const firstStatement = getBody.slice(0, getBody.indexOf("hasSignedPatientCookie") + 1);
    expect(firstStatement).not.toMatch(/clearPatientSessionCookie/);
  });
});
