// src/lib/auth/view-as.test.ts
import { describe, expect, it } from "vitest";
import {
  VIEW_AS_ROLES,
  VIEW_AS_DURATION_MS,
  activeViewAs,
  effectiveRole,
  formatRemaining,
  isViewAsRole,
} from "./view-as";
import {
  countdownRemainingMs,
  expiryRefreshDelay,
  formatRemainingMs,
  hasStaleViewAs,
  remainingMsFrom,
  viewAsStateKey,
} from "./view-as";

const NOW = new Date("2026-09-25T04:00:00.000Z");
const FUTURE = "2026-09-25T07:40:00.000Z"; // 3h40m later
const PAST = "2026-09-25T03:59:59.000Z";

describe("VIEW_AS_ROLES", () => {
  it("is exactly the four non-admin staff roles", () => {
    expect([...VIEW_AS_ROLES].sort()).toEqual(
      ["medtech", "pathologist", "reception", "xray_technician"].sort(),
    );
    expect(VIEW_AS_DURATION_MS).toBe(4 * 60 * 60 * 1000);
  });
  it("isViewAsRole accepts only those", () => {
    expect(isViewAsRole("reception")).toBe(true);
    expect(isViewAsRole("admin")).toBe(false);
    expect(isViewAsRole("")).toBe(false);
    expect(isViewAsRole(null)).toBe(false);
  });
});

describe("activeViewAs / effectiveRole", () => {
  it("admin + future expiry → override", () => {
    const p = { role: "admin", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(p, NOW)).toEqual({ role: "reception", until: FUTURE });
    expect(effectiveRole(p, NOW)).toBe("reception");
  });
  it("admin + past expiry → admin", () => {
    const p = { role: "admin", view_as_role: "reception", view_as_until: PAST };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("admin + expiry exactly now → admin (strict >)", () => {
    const p = { role: "admin", view_as_role: "medtech", view_as_until: NOW.toISOString() };
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("non-admin with override columns set → real role", () => {
    const p = { role: "medtech", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("medtech");
  });
  it("nulls → real role", () => {
    const p = { role: "admin", view_as_role: null, view_as_until: null };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("an unknown stored role (e.g. admin) is ignored", () => {
    const p = { role: "admin", view_as_role: "admin", view_as_until: FUTURE };
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("+08:00 and UTC spellings of the same instant agree", () => {
    const manila = { role: "admin", view_as_role: "reception", view_as_until: "2026-09-25T15:40:00+08:00" };
    const utc = { role: "admin", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(manila, NOW)?.until).toBe(activeViewAs(utc, NOW)?.until);
    expect(activeViewAs(manila, NOW)?.until).toBe(FUTURE);
  });
});

describe("formatRemaining", () => {
  it("hours and minutes", () => {
    expect(formatRemaining(FUTURE, NOW)).toBe("3h 40m");
  });
  it("minutes only", () => {
    expect(formatRemaining("2026-09-25T04:12:00.000Z", NOW)).toBe("12m");
  });
  it("under a minute, and never negative", () => {
    expect(formatRemaining("2026-09-25T04:00:30.000Z", NOW)).toBe("under a minute");
    expect(formatRemaining(PAST, NOW)).toBe("under a minute");
  });
});

describe("formatRemainingMs", () => {
  it("formats hours+minutes, minutes, and the sub-minute floor", () => {
    expect(formatRemainingMs(3 * 3_600_000 + 40 * 60_000 + 59_000)).toBe("3h 40m");
    expect(formatRemainingMs(12 * 60_000)).toBe("12m");
    expect(formatRemainingMs(59_999)).toBe("under a minute");
    expect(formatRemainingMs(-5)).toBe("under a minute");
    expect(formatRemainingMs(Number.NaN)).toBe("under a minute");
  });
});

describe("expiryRefreshDelay", () => {
  it("fires one second after the server-side remaining time, never negative", () => {
    expect(expiryRefreshDelay(60_000)).toBe(61_000);
    expect(expiryRefreshDelay(0)).toBe(1_000);
    expect(expiryRefreshDelay(-30_000)).toBe(1_000);
  });
});

describe("hasStaleViewAs", () => {
  const now = new Date("2026-09-28T04:00:00.000Z");
  it("is true only for an admin row carrying an expired override", () => {
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T03:59:59.000Z" }, now)).toBe(true);
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T04:00:00.000Z" }, now)).toBe(true);
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T05:00:00.000Z" }, now)).toBe(false);
    expect(hasStaleViewAs({ role: "admin", view_as_role: null, view_as_until: null }, now)).toBe(false);
    expect(hasStaleViewAs({ role: "medtech", view_as_role: "reception", view_as_until: "2026-09-28T03:00:00.000Z" }, now)).toBe(false);
  });
});

describe("countdownRemainingMs", () => {
  it("no tick yet: returns remainingMs unchanged", () => {
    expect(countdownRemainingMs(12 * 60_000, null)).toBe(12 * 60_000);
  });
  it("a tick matching the current remainingMs subtracts its elapsed time", () => {
    expect(countdownRemainingMs(12 * 60_000, { base: 12 * 60_000, elapsed: 30_000 })).toBe(
      12 * 60_000 - 30_000,
    );
  });
  it("a stale tick from an older remainingMs (a new server render arrived) is ignored", () => {
    expect(countdownRemainingMs(20 * 60_000, { base: 12 * 60_000, elapsed: 30_000 })).toBe(
      20 * 60_000,
    );
  });
  it("can go negative once elapsed exceeds remainingMs; formatRemainingMs reads it as under a minute", () => {
    const left = countdownRemainingMs(30_000, { base: 30_000, elapsed: 45_000 });
    expect(left).toBe(-15_000);
    expect(formatRemainingMs(left)).toBe("under a minute");
  });
});

describe("remainingMsFrom", () => {
  it("is the server clock's ms until an ISO expiry, not the device clock", () => {
    expect(remainingMsFrom(FUTURE, NOW)).toBe(3 * 3_600_000 + 40 * 60_000);
    expect(remainingMsFrom(PAST, NOW)).toBeLessThan(0);
  });
});

describe("viewAsStateKey", () => {
  it("changes with role and with until, and is stable for none", () => {
    expect(viewAsStateKey(null)).toBe("none");
    expect(viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:00.000Z" })).toBe(
      "reception@2026-09-28T08:00:00.000Z",
    );
    expect(viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:01.000Z" })).not.toBe(
      viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:00.000Z" }),
    );
  });
});
