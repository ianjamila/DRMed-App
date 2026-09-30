import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  notifyOne: vi.fn(async (a: unknown) => void a),
  notifyBulk: vi.fn(async (a: unknown) => void a),
  reported: [] as unknown[],
  notifyThrows: false,
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: unknown) => {
    if (fx.notifyThrows) throw new Error("boom");
    return fx.notifyOne(a);
  },
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: unknown) => fx.notifyBulk(a),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: unknown) => void fx.reported.push(a),
}));

import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { RELEASE_BLOCKED_CONSENT, RELEASE_REFUSAL_PATIENT_INACTIVE } from "@/lib/visits/release-messages";
const { releaseRows, notifyReleased } = await import("./release-rows");

interface Row {
  id: string;
  section: string;
  name: string;
  patient?: { deleted_at: string | null; merged_into_id: string | null };
}

/** Minimal chainable fake: the candidate read returns `rows` (already filtered by the DB in reality); the update returns `updateRows` or an error. */
function fakeDb(opts: {
  rows: Row[];
  updateError?: { code: string; message: string };
  updateReturns?: string[];
}) {
  type Filter = { op: string; column: string; value: unknown };
  const calls = { updateIds: [] as string[], updated: false, readFilters: [] as Filter[], updateFilters: [] as Filter[] };
  const db = {
    from: () => {
      let mode: "read" | "update" = "read";
      let inIds: string[] = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = () => {
        mode = "update";
        calls.updated = true;
        return q;
      };
      const record = (f: Filter) => (mode === "read" ? calls.readFilters : calls.updateFilters).push(f);
      q.in = (column: string, ids: string[]) => {
        record({ op: "in", column, value: ids });
        inIds = ids;
        if (mode === "update") calls.updateIds = ids;
        return q;
      };
      q.eq = (column: string, value: unknown) => (record({ op: "eq", column, value }), q);
      q.is = (column: string, value: unknown) => (record({ op: "is", column, value }), q);
      // not(column, operator, value) — recorded as op "not.<operator>".
      q.not = (column: string, operator: string, value: unknown) => (
        record({ op: `not.${operator}`, column, value }), q
      );
      q.then = (resolve: (v: unknown) => unknown) => {
        if (mode === "read") {
          const data = opts.rows
            .filter((r) => inIds.includes(r.id))
            .map((r) => ({
              id: r.id,
              deleted_at: null,
              services: { section: r.section, name: r.name, kind: "lab_test" },
              visits: { deleted_at: null, patients: r.patient ?? { deleted_at: null, merged_into_id: null } },
            }));
          return resolve({ data, error: null });
        }
        if (opts.updateError) return resolve({ data: null, error: opts.updateError });
        const ids = opts.updateReturns ?? calls.updateIds;
        return resolve({
          data: ids.map((id) => ({ id, services: { name: opts.rows.find((r) => r.id === id)?.name ?? "X" } })),
          error: null,
        });
      };
      return q;
    },
  };
  return { db: db as never, calls };
}

const admin = { user_id: "u1", role: "admin" } as never;
const medtech = { user_id: "u2", role: "medtech" } as never;

beforeEach(() => {
  fx.audits.length = 0;
  fx.reported.length = 0;
  fx.notifyOne.mockClear();
  fx.notifyBulk.mockClear();
  fx.notifyThrows = false;
});

describe("releaseRows", () => {
  it("releases only in-section rows and returns exactly the rows the UPDATE returned", async () => {
    const { db, calls } = fakeDb({
      rows: [
        { id: "a", section: "chemistry", name: "FBS" },
        { id: "b", section: "imaging_xray", name: "CXR" },
      ],
    });
    const r = await releaseRows({ supabase: db, session: medtech, visitId: "v1", ids: ["a", "b"], medium: "email" });
    expect(calls.updateIds).toEqual(["a"]);
    expect(r).toEqual({ ok: true, released: [{ id: "a", name: "FBS" }] });
  });

  it("pins the filters on the read and on the UPDATE", async () => {
    const { db, calls } = fakeDb({ rows: [{ id: "a", section: "chemistry", name: "FBS" }] });
    await releaseRows({ supabase: db, session: admin, visitId: "v1", ids: ["a"], medium: "email" });
    expect(calls.readFilters).toEqual(
      expect.arrayContaining([
        { op: "not.in", column: "services.kind", value: DOCTOR_KINDS_PG_LIST },
        { op: "is", column: "deleted_at", value: null },
        { op: "is", column: "visits.deleted_at", value: null },
        { op: "eq", column: "status", value: "ready_for_release" },
        { op: "eq", column: "is_package_header", value: false },
        { op: "eq", column: "visit_id", value: "v1" },
      ]),
    );
    expect(calls.updateFilters).toEqual(
      expect.arrayContaining([
        { op: "eq", column: "status", value: "ready_for_release" },
        { op: "eq", column: "visit_id", value: "v1" },
        { op: "in", column: "id", value: ["a"] },
      ]),
    );
  });

  it("audits one row per released id with auditMeta merged in", async () => {
    const { db } = fakeDb({
      rows: [
        { id: "a", section: "chemistry", name: "FBS" },
        { id: "b", section: "chemistry", name: "BUN" },
      ],
    });
    await releaseRows({
      supabase: db, session: admin, visitId: "v1", ids: ["a", "b"], medium: "physical",
      auditMeta: { queue: true },
    });
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
    expect(fx.audits[0]).toMatchObject({
      actor_id: "u1",
      actor_type: "staff",
      action: "test_request.released",
      resource_type: "test_request",
      ip_address: "1.2.3.4",
      user_agent: "ua",
      metadata: { visit_id: "v1", release_medium: "physical", bulk: true, selection: true, queue: true },
    });
  });

  it("audits only what the UPDATE returned (a race loser is not audited)", async () => {
    const { db } = fakeDb({
      rows: [
        { id: "a", section: "chemistry", name: "FBS" },
        { id: "b", section: "chemistry", name: "BUN" },
      ],
      updateReturns: ["a"],
    });
    const r = await releaseRows({ supabase: db, session: admin, visitId: "v1", ids: ["a", "b"], medium: "email" });
    expect(r).toEqual({ ok: true, released: [{ id: "a", name: "FBS" }] });
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a"]);
  });

  it("never notifies by itself", async () => {
    const { db } = fakeDb({ rows: [{ id: "a", section: "chemistry", name: "FBS" }] });
    await releaseRows({ supabase: db, session: admin, visitId: "v1", ids: ["a"], medium: "email" });
    expect(fx.notifyOne).not.toHaveBeenCalled();
    expect(fx.notifyBulk).not.toHaveBeenCalled();
  });

  it("returns nothing released, without writing, when no candidate is in section", async () => {
    const { db, calls } = fakeDb({ rows: [{ id: "b", section: "imaging_xray", name: "CXR" }] });
    const r = await releaseRows({ supabase: db, session: medtech, visitId: "v1", ids: ["b"], medium: "email" });
    expect(r).toEqual({ ok: true, released: [] });
    expect(calls.updated).toBe(false);
  });

  it("refuses, without writing, when the patient is merged or deleted", async () => {
    const { db, calls } = fakeDb({
      rows: [{ id: "a", section: "chemistry", name: "FBS", patient: { deleted_at: null, merged_into_id: "p2" } }],
    });
    const r = await releaseRows({ supabase: db, session: admin, visitId: "v1", ids: ["a"], medium: "email" });
    expect(r).toEqual({ ok: false, error: RELEASE_REFUSAL_PATIENT_INACTIVE });
    expect(calls.updated).toBe(false);
  });

  it("translates a database refusal", async () => {
    const { db } = fakeDb({
      rows: [{ id: "a", section: "chemistry", name: "FBS" }],
      updateError: { code: "23514", message: "consent required before release" },
    });
    const r = await releaseRows({ supabase: db, session: admin, visitId: "v1", ids: ["a"], medium: "email" });
    expect(r).toEqual({ ok: false, error: RELEASE_BLOCKED_CONSENT });
    expect(fx.audits).toEqual([]);
  });
});

describe("notifyReleased", () => {
  it("does nothing for no rows", async () => {
    await notifyReleased("v1", [], "email");
    expect(fx.notifyOne).not.toHaveBeenCalled();
    expect(fx.notifyBulk).not.toHaveBeenCalled();
  });
  it("uses the single notifier for one row", async () => {
    await notifyReleased("v1", [{ id: "a", name: "FBS" }], "email");
    expect(fx.notifyOne).toHaveBeenCalledWith({ testRequestId: "a", visitId: "v1", releaseMedium: "email" });
  });
  it("uses the bulk notifier for several rows", async () => {
    await notifyReleased("v1", [{ id: "a", name: "FBS" }, { id: "b", name: "BUN" }], "email");
    expect(fx.notifyBulk).toHaveBeenCalledWith({
      visitId: "v1", testRequestIds: ["a", "b"], testNames: ["FBS", "BUN"], releaseMedium: "email",
    });
  });
  it("reports a notify failure instead of throwing", async () => {
    fx.notifyThrows = true;
    await expect(notifyReleased("v1", [{ id: "a", name: "FBS" }], "email")).resolves.toBeUndefined();
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0]).toMatchObject({ scope: "notify/result-released-selection" });
  });
});
