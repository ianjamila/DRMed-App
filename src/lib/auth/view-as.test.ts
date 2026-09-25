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
