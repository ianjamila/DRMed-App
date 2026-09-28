// src/lib/auth/require-staff.test.ts
// `requireSignedInStaff()` clears a stale admin View-as override (an
// override that has run out but is still stored on the row) by awaiting
// `expireStaleViewAs()` before the session is returned — case (a) below.
// Everything else (active override, a non-admin row carrying stale columns,
// no override at all) must NOT call it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  user: { id: "user-1", email: "ada@x.test" } as { id: string; email: string } | null,
  profile: null as Record<string, unknown> | null,
  redirected: null as string | null,
  signedOut: 0,
  audits: [] as Record<string, unknown>[],
  expireCalls: [] as { userId: string; ctx: { ip: string | null; ua: string | null } }[],
  expireDelayMs: 0,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-for": "10.0.0.1, 1.2.3.4",
      "user-agent": "vitest-agent",
    }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    fx.redirected = to;
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: fx.user } }),
      signOut: async () => {
        fx.signedOut++;
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: fx.profile }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));

vi.mock("@/lib/auth/view-as-switch", () => ({
  expireStaleViewAs: async (userId: string, ctx: { ip: string | null; ua: string | null }) => {
    // A small delay so a test can assert the call is genuinely awaited
    // before requireSignedInStaff() resolves, not just fired-and-forgotten.
    await new Promise((r) => setTimeout(r, fx.expireDelayMs));
    fx.expireCalls.push({ userId, ctx });
  },
}));

const { requireSignedInStaff } = await import("./require-staff");

function activeProfile(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Ada Admin",
    role: "admin",
    is_active: true,
    deleted_at: null,
    view_as_role: null,
    view_as_until: null,
    ...overrides,
  };
}

beforeEach(() => {
  fx.user = { id: "user-1", email: "ada@x.test" };
  fx.profile = activeProfile();
  fx.redirected = null;
  fx.signedOut = 0;
  fx.audits = [];
  fx.expireCalls = [];
  fx.expireDelayMs = 0;
});

describe("requireSignedInStaff — stale View-as expiry", () => {
  it("(a) admin + override expired 1 minute ago: expireStaleViewAs called once with (user id, ip/ua); session is real role, no view_as", async () => {
    fx.profile = activeProfile({
      view_as_role: "reception",
      view_as_until: new Date(Date.now() - 60_000).toISOString(),
    });

    const session = await requireSignedInStaff();

    expect(fx.expireCalls).toEqual([
      { userId: "user-1", ctx: { ip: "10.0.0.1", ua: "vitest-agent" } },
    ]);
    expect(session.role).toBe("admin");
    expect(session.actual_role).toBe("admin");
    expect(session.view_as).toBeNull();
  });

  it("(b) admin + active override: expireStaleViewAs is not called; session reflects the override", async () => {
    fx.profile = activeProfile({
      view_as_role: "reception",
      view_as_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const session = await requireSignedInStaff();

    expect(fx.expireCalls).toHaveLength(0);
    expect(session.role).toBe("reception");
    expect(session.actual_role).toBe("admin");
    expect(session.view_as).toEqual({
      role: "reception",
      until: fx.profile.view_as_until,
    });
  });

  it("(c) a medtech row carrying stale override columns: expireStaleViewAs is not called (only an admin row can hold a live override)", async () => {
    fx.profile = activeProfile({
      role: "medtech",
      view_as_role: "reception",
      view_as_until: new Date(Date.now() - 60_000).toISOString(),
    });

    const session = await requireSignedInStaff();

    expect(fx.expireCalls).toHaveLength(0);
    expect(session.role).toBe("medtech");
    expect(session.view_as).toBeNull();
  });

  it("(d) admin with no override: expireStaleViewAs is not called", async () => {
    fx.profile = activeProfile();

    const session = await requireSignedInStaff();

    expect(fx.expireCalls).toHaveLength(0);
    expect(session.role).toBe("admin");
    expect(session.view_as).toBeNull();
  });

  it("(e) the call is genuinely awaited: the session only resolves after expireStaleViewAs's promise settles", async () => {
    fx.profile = activeProfile({
      view_as_role: "reception",
      view_as_until: new Date(Date.now() - 60_000).toISOString(),
    });
    fx.expireDelayMs = 20;

    const session = await requireSignedInStaff();

    // If requireSignedInStaff did not await expireStaleViewAs, the recorder's
    // setTimeout would not have fired yet by the time this line runs.
    expect(fx.expireCalls).toHaveLength(1);
    expect(session.role).toBe("admin");
  });
});
