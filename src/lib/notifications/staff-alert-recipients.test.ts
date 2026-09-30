import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const reported = vi.hoisted(() => [] as Array<{ scope: string; metadata?: Record<string, unknown> }>);
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: { scope: string; metadata?: Record<string, unknown> }) => void reported.push(a),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import {
  loadActiveStaffForAlerts,
  loadAuthEmails,
  resolveStaffAlertRecipients,
} from "./staff-alert-recipients";

type Res = { data: unknown; error: { message: string } | null };
interface Fake {
  /** listUsers result by 1-based page. Missing page → empty page. */
  pages: Record<number, Res>;
  tables: Record<string, Res>;
}

// Just enough of the service-role client for the three reads: every builder
// method returns the builder, and awaiting it (or .maybeSingle()) yields the
// table's canned result.
function fakeAdmin(f: Fake) {
  const builder = (table: string) => {
    const res =
      f.tables[table] ??
      (table === "staff_alert_settings" ? { data: { enabled: true }, error: null } : { data: [], error: null });
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order", "in"]) b[m] = () => b;
    b.maybeSingle = async () => res;
    b.then = (ok: (r: Res) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
    return b;
  };
  return {
    from: builder,
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number }) => f.pages[page] ?? { data: { users: [] }, error: null },
      },
    },
  } as never;
}

const users = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${from + i}`, email: `u${from + i}@drmed.test` }));
const page = (list: Array<{ id: string; email: string }>): Res => ({ data: { users: list }, error: null });
const profiles = (ids: string[], role = "reception"): Res => ({
  data: ids.map((id) => ({ id, full_name: id, role })),
  error: null,
});

beforeEach(() => {
  reported.length = 0;
});

describe("loadAuthEmails", () => {
  it("pages until a short page and reports no error", async () => {
    const r = await loadAuthEmails(fakeAdmin({ pages: { 1: page(users(200)), 2: page(users(3, 200)) }, tables: {} }));
    expect(r.error).toBeNull();
    expect(r.byId.size).toBe(203);
  });

  it("an error on a LATER page is an error, not a shorter list", async () => {
    const r = await loadAuthEmails(
      fakeAdmin({ pages: { 1: page(users(200)), 2: { data: null, error: { message: "timeout" } } }, tables: {} }),
    );
    expect(r.error).toContain("timeout");
    expect(r.byId.size).toBe(200);
  });

  it("an error on the first page is an error", async () => {
    const r = await loadAuthEmails(fakeAdmin({ pages: { 1: { data: null, error: { message: "401" } } }, tables: {} }));
    expect(r.error).toContain("401");
    expect(r.byId.size).toBe(0);
  });

  it("running out of pages while every page is full is reported, not silently truncated", async () => {
    const pages: Record<number, Res> = {};
    for (let p = 1; p <= 60; p++) pages[p] = page(users(200, p * 1000));
    const r = await loadAuthEmails(fakeAdmin({ pages, tables: {} }));
    expect(r.error).toBeTruthy();
  });
});

describe("loadActiveStaffForAlerts", () => {
  it("a failed profile read is a load error", async () => {
    const r = await loadActiveStaffForAlerts(
      fakeAdmin({ pages: { 1: page(users(2)) }, tables: { staff_profiles: { data: null, error: { message: "rls" } } } }),
    );
    expect(r.staff).toEqual([]);
    expect(r.loadError).toContain("rls");
  });

  it("passes through an email-list error while still returning the staff", async () => {
    const r = await loadActiveStaffForAlerts(
      fakeAdmin({
        pages: { 1: { data: null, error: { message: "timeout" } } },
        tables: { staff_profiles: profiles(["u0"]) },
      }),
    );
    expect(r.staff.map((s) => s.id)).toEqual(["u0"]);
    expect(r.staff[0].email).toBeNull();
    expect(r.loadError).toContain("timeout");
  });

  it("no error on a clean read", async () => {
    const r = await loadActiveStaffForAlerts(
      fakeAdmin({ pages: { 1: page(users(1)) }, tables: { staff_profiles: profiles(["u0"]) } }),
    );
    expect(r.loadError).toBeNull();
    expect(r.staff[0].email).toBe("u0@drmed.test");
  });
});

describe("resolveStaffAlertRecipients", () => {
  it("a clean read with nobody on has no loadError", async () => {
    const r = await resolveStaffAlertRecipients(
      "result_released",
      fakeAdmin({ pages: { 1: page(users(1)) }, tables: { staff_profiles: profiles(["u0"], "medtech") } }),
    );
    expect(r.emails).toEqual([]);
    expect(r.loadError).toBeNull();
    expect(reported).toHaveLength(0);
  });

  it("an auth listUsers failure surfaces as loadError and is reported once", async () => {
    const r = await resolveStaffAlertRecipients(
      "result_released",
      fakeAdmin({
        pages: { 1: { data: null, error: { message: "timeout" } } },
        tables: { staff_profiles: profiles(["u0"]) },
      }),
    );
    expect(r.emails).toEqual([]);
    expect(r.staffWithoutEmail).toEqual(["u0"]);
    expect(r.loadError).toContain("timeout");
    expect(reported).toHaveLength(1);
    expect(reported[0].scope).toBe("notify/staff-alert-recipients");
    expect(reported[0].metadata).toMatchObject({ alert_key: "result_released" });
  });

  it("a failed recipients read is a loadError too (opt-outs and extra inboxes were not seen)", async () => {
    const r = await resolveStaffAlertRecipients(
      "result_released",
      fakeAdmin({
        pages: { 1: page(users(1)) },
        tables: {
          staff_profiles: profiles(["u0"]),
          staff_alert_recipients: { data: null, error: { message: "gone" } },
        },
      }),
    );
    expect(r.emails).toEqual(["u0@drmed.test"]);
    expect(r.loadError).toContain("gone");
  });

  it("an alert switched OFF stays off when a different read fails", async () => {
    const r = await resolveStaffAlertRecipients(
      "result_released",
      fakeAdmin({
        pages: { 1: { data: null, error: { message: "timeout" } } },
        tables: {
          staff_profiles: profiles(["u0"]),
          staff_alert_settings: { data: { enabled: false }, error: null },
        },
      }),
    );
    expect(r.enabled).toBe(false);
    expect(r.emails).toEqual([]);
    expect(r.loadError).toContain("timeout");
  });

  it("a failed settings read still fails OPEN (enabled) but is reported", async () => {
    const r = await resolveStaffAlertRecipients(
      "result_released",
      fakeAdmin({
        pages: { 1: page(users(1)) },
        tables: {
          staff_profiles: profiles(["u0"]),
          staff_alert_settings: { data: null, error: { message: "settings down" } },
        },
      }),
    );
    expect(r.enabled).toBe(true);
    expect(r.emails).toEqual(["u0@drmed.test"]);
    expect(r.loadError).toContain("settings down");
  });
});
