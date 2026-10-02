import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review finding 3 (P1, 2026-09-30): restoreTestRequestsForVisit used to
// filter the READ by the exact deleted_at a bulk Undo expected (sameInstant),
// but predicate the WRITE only on "deleted_at is not null" — so a
// restore-and-re-delete landing between the read and the write still matched
// that looser predicate and got silently undone by an Undo that had nothing
// to do with it. The fix groups the validated rows by the exact deleted_at
// value read (groupIdsByDeletedAt, src/lib/queue/partial-panel.ts — its own
// grouping logic is unit-tested there) and issues one UPDATE per group, each
// predicated on `.eq("deleted_at", thatValue)`. restoreTestRequestsForVisit
// itself has no pure seam (admin client, StaffSession, audit()) — pinned here
// as source text.

const FILE = join(process.cwd(), "src/lib/actions/visits/queue-restore-core.ts");
const src = readFileSync(FILE, "utf8");

describe("restoreTestRequestsForVisit's bulk-Undo write predicates on the exact deleted_at read, not just NOT NULL", () => {
  it("groups the expectedDeletedAtOf branch's rows via groupIdsByDeletedAt", () => {
    expect(src).toMatch(/import \{ groupIdsByDeletedAt \} from "@\/lib\/queue\/partial-panel";/);
    expect(src).toMatch(/groupIdsByDeletedAt\(/);
  });

  it("the expectedDeletedAtOf branch's write predicates on the exact value, never merely NOT NULL", () => {
    const branchStart = src.indexOf("if (expectedDeletedAtOf) {", src.indexOf("let restored:"));
    expect(branchStart, "expectedDeletedAtOf write branch not found").toBeGreaterThan(-1);
    const branchEnd = src.indexOf("\n  } else {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/\.eq\("deleted_at",\s*deletedAtValue\)/);
    expect(branch).not.toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
  });

  it("the manual-restore (no expectedDeletedAtOf) branch is unchanged: still predicates on NOT NULL", () => {
    const elseStart = src.indexOf("\n  } else {", src.indexOf("let restored:"));
    expect(elseStart).toBeGreaterThan(-1);
    const elseEnd = src.indexOf("\n  }\n\n  const rowById", elseStart);
    expect(elseEnd).toBeGreaterThan(elseStart);
    const branch = src.slice(elseStart, elseEnd);
    expect(branch).toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
    expect(branch).not.toMatch(/groupIdsByDeletedAt/);
  });

  it("every write in both branches still scopes to the visit", () => {
    // Losing `.eq("visit_id", visitId)` on either branch would let a
    // same-batch id belonging to a DIFFERENT visit slip through the write.
    const writes = [...src.matchAll(/\.update\(\{ deleted_at: null[\s\S]{0,300}?\.select\("id"\)/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      expect(w[0]).toMatch(/\.eq\("visit_id",\s*visitId\)/);
    }
  });
});

// Behavioural: a restore UPDATE that loses a lock race (40P01) re-runs once.
// PR B's proof (S7, scripts/panel-undo-concurrency-proof.ts) showed a manual
// Restore racing a panel Undo-restore on one visit can lose a deadlock. The
// fake below stands in for the admin client: the read returns the candidate
// rows, each UPDATE pops the next scripted result.
const fx = vi.hoisted(() => ({
  candidates: [] as unknown[],
  updateResults: [] as Array<{ data: { id: string }[] | null; error: { code?: string; message?: string } | null }>,
  updates: [] as Array<{ filters: Array<[string, ...unknown[]]> }>,
  audits: [] as Array<{ resource_id: string }>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from() {
      let isUpdate = false;
      const filters: Array<[string, ...unknown[]]> = [];
      const q: Record<string, unknown> = {};
      q.update = () => {
        isUpdate = true;
        return q;
      };
      for (const m of ["select", "in", "eq", "not", "is"]) {
        q[m] = (...args: unknown[]) => {
          filters.push([m, ...args]);
          return q;
        };
      }
      q.then = (res: (v: unknown) => unknown) => {
        if (!isUpdate) return res({ data: fx.candidates, error: null });
        fx.updates.push({ filters });
        return res(fx.updateResults.shift() ?? { data: [], error: null });
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: { resource_id: string }) => void fx.audits.push(e) }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));

const { restoreTestRequestsForVisit } = await import("./queue-restore-core");

const SESSION = { user_id: "u1", role: "admin" } as never;
const candidate = (id: string, deletedAt: string) => ({
  id,
  deleted_at: deletedAt,
  delete_reason: "typo",
  parent_id: null,
  visits: { patient_id: "p1", deleted_at: null },
  services: { name: "CBC", code: "CBC" },
});
const T1 = "2026-10-02T01:00:00.000Z";
const T2 = "2026-10-02T01:00:05.000Z";
const LOST = { data: null, error: { code: "40P01", message: "deadlock detected" } };
const OK = (...ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null });

beforeEach(() => {
  fx.candidates = [];
  fx.updateResults = [];
  fx.updates = [];
  fx.audits = [];
});

describe("manual Restore retries a lost lock race once", () => {
  beforeEach(() => {
    fx.candidates = [candidate("a", T1), candidate("b", T1)];
  });

  it("40P01 then success: ok, exactly two UPDATEs, one audit row per line", async () => {
    fx.updateResults = [LOST, OK("a", "b")];
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: true, restoredIds: ["a", "b"] });
    expect(fx.updates).toHaveLength(2);
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
  });

  it("a second 40P01 returns the translated error and audits nothing", async () => {
    fx.updateResults = [LOST, LOST];
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).not.toBe("");
    expect(fx.updates).toHaveLength(2);
    expect(fx.audits).toHaveLength(0);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    fx.updateResults = [{ data: null, error: { code: "XX000", message: "boom" } }, OK("a", "b")];
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out.ok).toBe(false);
    expect(fx.updates).toHaveLength(1);
    expect(fx.audits).toHaveLength(0);
  });
});

describe("bulk Undo (expected deleted_at) retries each group the same way", () => {
  it("a group that loses the race re-runs once; the other group is untouched", async () => {
    fx.candidates = [candidate("a", T1), candidate("b", T2)];
    // group T1: lost, then ok; group T2: ok first time.
    fx.updateResults = [LOST, OK("a"), OK("b")];
    const out = await restoreTestRequestsForVisit(
      SESSION,
      "v1",
      ["a", "b"],
      "undo",
      {},
      new Map([
        ["a", T1],
        ["b", T2],
      ]),
    );
    expect(out).toEqual({ ok: true, restoredIds: ["a", "b"] });
    expect(fx.updates).toHaveLength(3);
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
  });

  it("a second 40P01 on a group is not retried again (translated error when nothing restored)", async () => {
    fx.candidates = [candidate("a", T1)];
    fx.updateResults = [LOST, LOST];
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out.ok).toBe(false);
    expect(fx.updates).toHaveLength(2);
    expect(fx.audits).toHaveLength(0);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    fx.candidates = [candidate("a", T1)];
    fx.updateResults = [{ data: null, error: { code: "XX000", message: "boom" } }, OK("a")];
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out.ok).toBe(false);
    expect(fx.updates).toHaveLength(1);
  });
});
