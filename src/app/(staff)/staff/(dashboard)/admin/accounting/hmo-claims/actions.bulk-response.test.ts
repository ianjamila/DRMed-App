import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for bulkSetHmoResponseAction's chunked write (0184 review
 * follow-up, HMO P2): before this fix the write was one atomic UPDATE, so
 * any failure meant nothing committed. Paging it into HMO_BULK_CHUNK-sized
 * (200) UPDATEs means a LATER chunk can fail after an EARLIER one already
 * committed — this file pins that the action then still audits and
 * revalidates what was actually updated, and reports the partial result
 * (rather than a bare error implying nothing happened), while a FIRST-chunk
 * failure (nothing yet committed) still behaves exactly as a single atomic
 * UPDATE always did.
 *
 * The admin client is faked table-by-table, the shape used in
 * src/lib/actions/accounting/post-till-cash-expense.test.ts. Patient-active
 * filtering (activeTestRequestIds) is mocked to treat every item as active —
 * that gate has its own tests elsewhere.
 */

vi.mock("server-only", () => ({}));

const BATCH_ID = "33333333-3333-4333-8333-333333333333";
// 250 candidate items — HMO_BULK_CHUNK (200) splits this into two write
// chunks (200 + 50), so a failure can land on the second chunk only.
const ITEM_COUNT = 250;

const fx = vi.hoisted(() => ({
  candidateRows: Array.from({ length: 250 }, (_, i) => ({
    id: `item-${i}`,
    test_request_id: `tr-${i}`,
  })),
  totalCount: 250,
  // Index (0-based, across the whole run) of the write chunk that should
  // fail, or null for "every chunk succeeds".
  failAtChunk: null as number | null,
  chunkAttempt: 0,
  chunkError: { message: "connection reset", code: "08006" } as { message: string; code?: string },
  audits: [] as Record<string, unknown>[],
  revalidated: [] as unknown[][],
}));

function hmoClaimItemsTable() {
  const q: {
    _headCount: boolean;
    _update: Record<string, unknown> | null;
    _in: unknown[] | null;
    select: (cols: string, opts?: { count?: string; head?: boolean }) => unknown;
    eq: () => unknown;
    order: () => typeof q;
    range: () => Promise<{ data: typeof fx.candidateRows; error: null }>;
    update: (payload: Record<string, unknown>) => typeof q;
    in: (col: string, vals: unknown[]) => typeof q;
  } = {
    _headCount: false,
    _update: null,
    _in: null,
    select: (_cols, opts) => {
      if (q._update) {
        // Write terminal: update(...).eq(...).in(...)[.eq(...)].select("id").
        const idx = fx.chunkAttempt++;
        if (fx.failAtChunk !== null && idx === fx.failAtChunk) {
          return Promise.resolve({ data: null, error: fx.chunkError });
        }
        return Promise.resolve({ data: (q._in ?? []).map((id) => ({ id })), error: null });
      }
      if (opts?.head) {
        q._headCount = true;
      }
      return q;
    },
    eq: () => {
      if (q._headCount) {
        return Promise.resolve({ count: fx.totalCount, data: null, error: null });
      }
      return q;
    },
    order: () => q,
    range: async () => ({ data: fx.candidateRows, error: null }),
    update: (payload) => {
      q._update = payload;
      return q;
    },
    in: (_col, vals) => {
      q._in = vals;
      return q;
    },
  };
  return q;
}

vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    fx.revalidated.push(args);
  },
}));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({ user_id: "admin-1", email: "", full_name: "Admin", role: "admin" }),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));
vi.mock("@/lib/patients/require-active", () => ({
  assertTestRequestsPatientsActive: async () => ({ ok: true }),
  assertClaimItemsPatientsActive: async () => ({ ok: true }),
  assertResolutionPatientActive: async () => ({ ok: true }),
  assertPaymentPatientActive: async () => ({ ok: true }),
  activeTestRequestIds: async (_admin: unknown, ids: readonly string[]) => new Set(ids),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "hmo_claim_items") return hmoClaimItemsTable();
      throw new Error(`unexpected table in test: ${table}`);
    },
  }),
}));

const { bulkSetHmoResponseAction } = await import("./actions");

function bulkInput(scope: "all" | "pending_only" = "all") {
  return {
    batch_id: BATCH_ID,
    response: "paid" as const,
    response_date: "2026-09-30",
    scope,
    notes: null,
  };
}

beforeEach(() => {
  fx.failAtChunk = null;
  fx.chunkAttempt = 0;
  fx.audits.length = 0;
  fx.revalidated.length = 0;
  fx.candidateRows = Array.from({ length: ITEM_COUNT }, (_, i) => ({
    id: `item-${i}`,
    test_request_id: `tr-${i}`,
  }));
  fx.totalCount = ITEM_COUNT;
});

describe("bulkSetHmoResponseAction — chunked write failure", () => {
  it("first-chunk failure: nothing committed, behaves exactly as a bare failure (no audit, no revalidate)", async () => {
    fx.failAtChunk = 0;
    const result = await bulkSetHmoResponseAction(bulkInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // translatePgError's default branch — unknown code, so the raw message
    // (or its own generic fallback) comes through; the key thing this test
    // pins is the SHAPE, not the exact fallback wording.
    expect(result.error).not.toMatch(/^Updated \d+ of \d+ items/);
    expect(fx.audits).toEqual([]);
    expect(fx.revalidated).toEqual([]);
  });

  it("later-chunk failure: audits + revalidates what committed, and reports the partial result", async () => {
    fx.failAtChunk = 1; // second chunk (0-indexed) — the first 200 already committed.
    const result = await bulkSetHmoResponseAction(bulkInput("all"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/^Updated 200 of 250 items, then stopped:/);
    expect(result.error).toMatch(/Run it again to update the rest/);

    expect(fx.audits).toHaveLength(1);
    const meta = fx.audits[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      items_updated: 200,
      failed_after_chunk: 1,
      error_code: "08006",
    });
    expect(fx.revalidated).toEqual([[`/staff/admin/accounting/hmo-claims/batches/${BATCH_ID}`]]);
  });

  it("later-chunk failure under pending_only scope: re-run note says already-updated items are skipped automatically", async () => {
    fx.failAtChunk = 1;
    const result = await bulkSetHmoResponseAction(bulkInput("pending_only"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/skipped automatically \(no longer pending\)/);
  });

  it("no failure: both chunks commit, one combined items_updated, no partial-failure audit", async () => {
    const result = await bulkSetHmoResponseAction(bulkInput());
    expect(result).toMatchObject({
      ok: true,
      data: { items_updated: 250, items_skipped: 0, items_skipped_inactive: 0, items_skipped_changed: 0 },
    });
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]!.metadata).not.toHaveProperty("failed_after_chunk");
  });
});
