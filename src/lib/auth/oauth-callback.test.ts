import { describe, expect, it, vi } from "vitest";
import {
  handleOAuthCallback,
  type OAuthCallbackDeps,
  type StaffProfileRow,
} from "./oauth-callback";

const ACTIVE: StaffProfileRow = {
  id: "u-1",
  full_name: "Ian Jamila",
  is_active: true,
  deleted_at: null,
};

function makeDeps(over: Partial<OAuthCallbackDeps> = {}): OAuthCallbackDeps {
  return {
    exchangeCode: vi
      .fn()
      .mockResolvedValue({ userId: "u-1", email: "a@b.com", error: null }),
    loadProfile: vi.fn().mockResolvedValue(ACTIVE),
    signOut: vi.fn().mockResolvedValue(undefined),
    deleteAuthUser: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const INPUT = { code: "abc", next: null, ip: "203.0.113.9", userAgent: "vitest" };

describe("handleOAuthCallback", () => {
  it("signs in an active staff member and audits the provider", async () => {
    const deps = makeDeps();
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out).toEqual({ kind: "success", redirectTo: "/staff" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: "u-1",
        actor_type: "staff",
        action: "staff.signin.success",
        metadata: { provider: "google" },
        ip_address: "203.0.113.9",
        user_agent: "vitest",
      }),
    );
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("honours a safe next path", async () => {
    const out = await handleOAuthCallback(
      { ...INPUT, next: "/staff/visits" },
      makeDeps(),
    );
    expect(out).toEqual({ kind: "success", redirectTo: "/staff/visits" });
  });

  it("refuses to redirect off-site", async () => {
    const out = await handleOAuthCallback(
      { ...INPUT, next: "//evil.example.com" },
      makeDeps(),
    );
    expect(out).toEqual({ kind: "success", redirectTo: "/staff" });
  });

  it("fails closed when Google sent no code", async () => {
    const deps = makeDeps();
    const out = await handleOAuthCallback({ ...INPUT, code: null }, deps);

    expect(out).toEqual({ kind: "failed", redirectTo: "/staff/login?error=auth_failed" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        actor_type: "anonymous",
        action: "staff.signin.failed",
        metadata: { provider: "google", reason: "no_code" },
      }),
    );
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("reports the real reason when the exchange fails", async () => {
    const deps = makeDeps({
      exchangeCode: vi
        .fn()
        .mockResolvedValue({ userId: null, email: null, error: "invalid flow state" }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("failed");
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.failed",
        metadata: { provider: "google", reason: "invalid flow state" },
      }),
    );
  });

  it("rejects a Google account with no staff profile AND deletes the orphan", async () => {
    const deps = makeDeps({ loadProfile: vi.fn().mockResolvedValue(null) });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out).toEqual({ kind: "rejected", redirectTo: "/staff/login?error=not_staff" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.rejected_inactive",
        metadata: {
          provider: "google",
          email: "a@b.com",
          has_profile: false,
          is_deleted: false,
        },
      }),
    );
    expect(deps.signOut).toHaveBeenCalled();
    expect(deps.deleteAuthUser).toHaveBeenCalledWith("u-1");
  });

  // staff_profiles.id cascades from auth.users, so deleting the auth user of a
  // real staff member would take their profile — and every audit row's name
  // resolution — with it.
  it("rejects an inactive staff member WITHOUT deleting them", async () => {
    const deps = makeDeps({
      loadProfile: vi.fn().mockResolvedValue({ ...ACTIVE, is_active: false }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("rejected");
    expect(deps.signOut).toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("rejects a soft-deleted staff member WITHOUT deleting them", async () => {
    const deps = makeDeps({
      loadProfile: vi
        .fn()
        .mockResolvedValue({ ...ACTIVE, deleted_at: "2026-01-01T00:00:00Z" }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("rejected");
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.rejected_inactive",
        metadata: {
          provider: "google",
          email: "a@b.com",
          has_profile: true,
          is_deleted: true,
        },
      }),
    );
  });

  it("records that a profile existed when rejecting an inactive user", async () => {
    const deps = makeDeps({
      loadProfile: vi.fn().mockResolvedValue({ ...ACTIVE, is_active: false }),
    });
    await handleOAuthCallback(INPUT, deps);

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          provider: "google",
          email: "a@b.com",
          has_profile: true,
          is_deleted: false,
        },
      }),
    );
  });

  it("reports exchange_failed when exchangeCode resolves with no error and no userId", async () => {
    const deps = makeDeps({
      exchangeCode: vi
        .fn()
        .mockResolvedValue({ userId: null, email: null, error: null }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out).toEqual({ kind: "failed", redirectTo: "/staff/login?error=auth_failed" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.failed",
        metadata: { provider: "google", reason: "exchange_failed" },
      }),
    );
  });
});
