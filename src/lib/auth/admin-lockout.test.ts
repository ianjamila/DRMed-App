import { describe, expect, it } from "vitest";
import { isSelfAdminLockout, wouldRemoveLastActiveAdmin } from "./admin-lockout";

describe("isSelfAdminLockout", () => {
  it("blocks an admin demoting their own role", () => {
    expect(
      isSelfAdminLockout(true, { role: "reception", is_active: true }),
    ).toBe(true);
  });

  it("blocks an admin deactivating their own account", () => {
    expect(
      isSelfAdminLockout(true, { role: "admin", is_active: false }),
    ).toBe(true);
  });

  it("blocks both changes at once", () => {
    expect(
      isSelfAdminLockout(true, { role: "reception", is_active: false }),
    ).toBe(true);
  });

  it("allows an admin to keep their own admin role active", () => {
    expect(
      isSelfAdminLockout(true, { role: "admin", is_active: true }),
    ).toBe(false);
  });

  it("never blocks editing someone else, regardless of the new values", () => {
    expect(
      isSelfAdminLockout(false, { role: "reception", is_active: false }),
    ).toBe(false);
  });
});

describe("wouldRemoveLastActiveAdmin", () => {
  it("blocks demoting the last active admin", () => {
    expect(
      wouldRemoveLastActiveAdmin(0, { role: "reception", is_active: true }),
    ).toBe(true);
  });

  it("blocks deactivating the last active admin", () => {
    expect(
      wouldRemoveLastActiveAdmin(0, { role: "admin", is_active: false }),
    ).toBe(true);
  });

  it("allows demoting an admin when another active admin remains", () => {
    expect(
      wouldRemoveLastActiveAdmin(1, { role: "reception", is_active: true }),
    ).toBe(false);
  });

  it("allows keeping the last admin as admin and active", () => {
    expect(
      wouldRemoveLastActiveAdmin(0, { role: "admin", is_active: true }),
    ).toBe(false);
  });

  it("is unaffected by a non-admin role change when other admins exist", () => {
    expect(
      wouldRemoveLastActiveAdmin(3, { role: "medtech", is_active: false }),
    ).toBe(false);
  });

  it("treats a negative count the same as zero (defensive)", () => {
    expect(
      wouldRemoveLastActiveAdmin(-1, { role: "reception", is_active: true }),
    ).toBe(true);
  });
});
