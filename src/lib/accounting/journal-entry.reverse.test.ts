import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocked-admin-client coverage for `reverseJournalEntryBySource`'s two Codex
 * P1 findings (2026-09-30):
 *
 *   1. Concurrent HMO Undo could reverse the same posted JE twice — the
 *      posted->draft transition used to be unconditional. Now it's a
 *      conditional claim (`.eq("status","posted")` + a row-count check), so
 *      a second caller that raced to the same original entry loses cleanly.
 *   2. A failed initial lookup was indistinguishable from "nothing posted",
 *      so a caller like HMO Undo would restore its own row while the
 *      original entry stayed posted. The lookup's error is now returned
 *      (fail closed) instead of discarded.
 *
 * `reverseJournalEntryBySource` takes the admin client as a plain parameter
 * (typed via `import type`, so there is no runtime import of
 * `@/lib/supabase/admin` to mock) — only "server-only" needs neutralising,
 * the same way `src/lib/actions/accounting/post-till-cash-expense.test.ts`
 * does it. The fake client below is a minimal thenable query-builder over an
 * in-memory fixture, since a real Supabase builder isn't worth standing up
 * for a handful of fixed calls.
 */

vi.mock("server-only", () => ({}));

import { reverseJournalEntryBySource } from "./journal-entry";

type Row = Record<string, unknown>;

const fx = vi.hoisted(() => ({
  // Lookup (source_kind/source_id/status='posted').
  lookupError: null as { code?: string; message?: string } | null,
  postedEntry: { id: "je-original" } as { id: string } | null,

  // Posted -> draft claim.
  draftClaimError: null as { code?: string; message?: string } | null,
  draftClaimWins: true, // false simulates a concurrent caller already having claimed it
  draftClaimCalls: [] as Row[],

  // journal_lines read.
  lines: [
    { account_id: "acct-1", debit_php: 100, credit_php: 0, description: "orig", line_order: 1, vendor_id: null },
    { account_id: "acct-2", debit_php: 0, credit_php: 100, description: "orig", line_order: 2, vendor_id: null },
  ] as Row[],
  linesReadError: null as { code?: string; message?: string } | null,

  // je_next_number RPC.
  entryNumber: "JE-0099" as string | null,
  rpcError: null as { code?: string; message?: string } | null,

  // Reversal JE insert.
  revJeId: "je-reversal",
  revJeInsertError: null as { code?: string; message?: string } | null,

  // Reversal line inserts.
  lineInsertError: null as { code?: string; message?: string } | null,
  insertedLines: [] as Row[],

  // Post the reversal / mark original reversed.
  postRevError: null as { code?: string; message?: string } | null,
  reversedUpdateError: null as { code?: string; message?: string } | null,

  // Call tracking for assertions.
  rollbackToPostedCalls: [] as string[],
  postRevCalls: [] as string[],
  reversedUpdateCalls: [] as string[],
  deleteJeCalls: [] as string[],
  deleteLinesCalls: [] as string[],
}));

function makeBuilder(table: "journal_entries" | "journal_lines") {
  let mode: "select" | "update" | "insert" | "delete" | null = null;
  let payload: Row = {};
  const filters: Row = {};

  function exec(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve().then(() => {
      if (table === "journal_entries") {
        if (mode === "select") {
          if (fx.lookupError) return { data: null, error: fx.lookupError };
          return { data: fx.postedEntry, error: null };
        }
        if (mode === "update") {
          if (payload.status === "draft") {
            fx.draftClaimCalls.push({ ...filters });
            if (fx.draftClaimError) return { data: null, error: fx.draftClaimError };
            const matches = fx.postedEntry && filters.id === fx.postedEntry.id && filters.status === "posted";
            return { data: matches && fx.draftClaimWins ? [{ id: filters.id }] : [], error: null };
          }
          if (payload.status === "posted") {
            if (filters.id === fx.revJeId) {
              fx.postRevCalls.push(String(filters.id));
              return { data: null, error: fx.postRevError };
            }
            fx.rollbackToPostedCalls.push(String(filters.id));
            return { data: null, error: null };
          }
          if (payload.status === "reversed") {
            fx.reversedUpdateCalls.push(String(filters.id));
            return { data: null, error: fx.reversedUpdateError };
          }
        }
        if (mode === "insert") {
          if (fx.revJeInsertError) return { data: null, error: fx.revJeInsertError };
          return { data: { id: fx.revJeId }, error: null };
        }
        if (mode === "delete") {
          fx.deleteJeCalls.push(String(filters.id));
          return { data: null, error: null };
        }
      }
      if (table === "journal_lines") {
        if (mode === "select") {
          return { data: fx.linesReadError ? null : fx.lines, error: fx.linesReadError };
        }
        if (mode === "insert") {
          if (fx.lineInsertError) return { data: null, error: fx.lineInsertError };
          fx.insertedLines.push(payload);
          return { data: null, error: null };
        }
        if (mode === "delete") {
          fx.deleteLinesCalls.push(String(filters.entry_id));
          return { data: null, error: null };
        }
      }
      throw new Error(`unhandled mock call: ${table} ${mode} ${JSON.stringify(filters)}`);
    });
  }

  const api = {
    select() {
      if (mode === null) mode = "select";
      return api;
    },
    eq(col: string, val: unknown) {
      filters[col] = val;
      return api;
    },
    order() {
      return api;
    },
    update(p: Row) {
      mode = "update";
      payload = p;
      return api;
    },
    insert(p: Row) {
      mode = "insert";
      payload = p;
      return api;
    },
    delete() {
      mode = "delete";
      return api;
    },
    maybeSingle() {
      return exec();
    },
    single() {
      return exec();
    },
    then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown, onRejected?: (e: unknown) => unknown) {
      return exec().then(onFulfilled, onRejected);
    },
  };
  return api;
}

function fakeAdmin() {
  return {
    from: (table: string) => makeBuilder(table as "journal_entries" | "journal_lines"),
    rpc: () => (fx.rpcError ? Promise.resolve({ data: null, error: fx.rpcError }) : Promise.resolve({ data: fx.entryNumber, error: null })),
    // Cast: the real AdminClient type is much wider than the handful of
    // chain methods reverseJournalEntryBySource actually calls.
  } as unknown as Parameters<typeof reverseJournalEntryBySource>[0];
}

function baseInput(overrides: Partial<Parameters<typeof reverseJournalEntryBySource>[1]> = {}) {
  return {
    sourceKind: "history_import" as const,
    sourceId: "claim-1",
    actorId: "staff-1",
    reason: "test reversal",
    ...overrides,
  };
}

beforeEach(() => {
  fx.lookupError = null;
  fx.postedEntry = { id: "je-original" };
  fx.draftClaimError = null;
  fx.draftClaimWins = true;
  fx.draftClaimCalls = [];
  fx.lines = [
    { account_id: "acct-1", debit_php: 100, credit_php: 0, description: "orig", line_order: 1, vendor_id: null },
    { account_id: "acct-2", debit_php: 0, credit_php: 100, description: "orig", line_order: 2, vendor_id: null },
  ];
  fx.linesReadError = null;
  fx.entryNumber = "JE-0099";
  fx.rpcError = null;
  fx.revJeId = "je-reversal";
  fx.revJeInsertError = null;
  fx.lineInsertError = null;
  fx.insertedLines = [];
  fx.postRevError = null;
  fx.reversedUpdateError = null;
  fx.rollbackToPostedCalls = [];
  fx.postRevCalls = [];
  fx.reversedUpdateCalls = [];
  fx.deleteJeCalls = [];
  fx.deleteLinesCalls = [];
});

describe("reverseJournalEntryBySource", () => {
  it("happy path: reverses the entry and returns null", async () => {
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput({ expectedEntryId: "je-original" }));
    expect(result).toBeNull();
    expect(fx.draftClaimCalls).toEqual([{ id: "je-original", status: "posted" }]);
    expect(fx.insertedLines).toHaveLength(2);
    expect(fx.postRevCalls).toEqual(["je-reversal"]);
    expect(fx.reversedUpdateCalls).toEqual(["je-original"]);
    expect(fx.rollbackToPostedCalls).toEqual([]);
  });

  it("race loser: the draft claim matches zero rows, so it errors without building a reversal", async () => {
    fx.draftClaimWins = false; // a concurrent caller already flipped it to draft
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput());
    expect(result).toMatch(/already reversed or changed/);
    expect(fx.insertedLines).toHaveLength(0);
    expect(fx.rollbackToPostedCalls).toEqual([]); // never claimed it, so nothing to roll back
    expect(fx.reversedUpdateCalls).toEqual([]);
  });

  it("lookup error is returned (fail closed), not treated as nothing-to-reverse", async () => {
    fx.lookupError = { message: "connection reset" };
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput());
    expect(result).toBe("connection reset");
    expect(fx.draftClaimCalls).toEqual([]); // never proceeds past a failed lookup
  });

  it("expectedEntryId mismatch: a different entry is posted than the caller expects", async () => {
    fx.postedEntry = { id: "je-someone-else" };
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput({ expectedEntryId: "je-original" }));
    expect(result).toMatch(/different journal entry/);
    expect(fx.draftClaimCalls).toEqual([]); // no claim attempted on the mismatched entry
  });

  it("expectedEntryId given but nothing is posted: an error, not the ordinary null no-op", async () => {
    fx.postedEntry = null;
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput({ expectedEntryId: "je-original" }));
    expect(result).toMatch(/no longer posted/);
  });

  it("no expectedEntryId and nothing is posted: the ordinary no-op (null)", async () => {
    fx.postedEntry = null;
    const result = await reverseJournalEntryBySource(fakeAdmin(), baseInput());
    expect(result).toBeNull();
  });
});
