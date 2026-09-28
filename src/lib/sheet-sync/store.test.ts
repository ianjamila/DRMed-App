/**
 * `createSupabaseStore`'s `lastGoodRowsRead` pages through run history instead
 * of a flat `.limit(30)` (review fix #6, Task 11): a `.limit(30)` alone could
 * scan 30 runs where e.g. lab kept failing while customers/consult succeeded,
 * and never find lab's last good count — silently disabling its snapshot
 * gate. Exercised with a minimal duck-typed stand-in for the one query chain
 * this method issues, not a real SupabaseClient.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/database";
import { createSupabaseStore, REVIEW_CHUNK } from "./store";
import type { ReviewItemInput } from "./types";

/** Serves `pages` in order off `.range()`; every other chain link just returns itself. */
function makeRunsClient(pages: ReadonlyArray<Array<{ per_tab: unknown }>>) {
  let pageIndex = 0;
  let rangeCalls = 0;
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    range: async () => {
      rangeCalls++;
      const data = pages[pageIndex] ?? [];
      pageIndex++;
      return { data, error: null };
    },
  };
  return { client: chain as unknown as SupabaseClient<Database>, rangeCallCount: () => rangeCalls };
}

describe("createSupabaseStore — lastGoodRowsRead", () => {
  it("pages past a tab that keeps failing to find its last good count, not just the newest 30 runs", async () => {
    // Page 1: 30 runs where customers/consult keep succeeding but lab keeps
    // failing (e.g. a header change that took a few nightly cycles to notice).
    const page1 = Array.from({ length: 30 }, () => ({
      per_tab: {
        customers: { status: "succeeded", rows_read: 10 },
        lab: { status: "failed" },
        consult: { status: "succeeded", rows_read: 5 },
      },
    }));
    // Page 2: the run where lab last succeeded — further back than a flat limit(30) would reach.
    const page2 = [{
      per_tab: {
        customers: { status: "succeeded", rows_read: 10 },
        lab: { status: "succeeded", rows_read: 77 },
        consult: { status: "succeeded", rows_read: 5 },
      },
    }];
    const { client, rangeCallCount } = makeRunsClient([page1, page2]);
    const store = createSupabaseStore(client);

    const out = await store.lastGoodRowsRead();

    expect(out).toEqual({ customers: 10, lab: 77, consult: 5 });
    expect(rangeCallCount()).toBe(2); // stopped the moment all three tabs were found
  });

  it("stops once a page comes back short (end of history) instead of scanning forever", async () => {
    const page1 = Array.from({ length: 5 }, () => ({
      per_tab: { customers: { status: "succeeded", rows_read: 1 } }, // lab/consult never succeeded in this short history
    }));
    const { client, rangeCallCount } = makeRunsClient([page1]);
    const store = createSupabaseStore(client);

    const out = await store.lastGoodRowsRead();

    expect(out).toEqual({ customers: 1 });
    expect(rangeCallCount()).toBe(1); // page1.length (5) < PAGE (30) — the loop stops rather than paging past the end
  });
});

describe("createSupabaseStore — loadPatients excludes deleted rows only (0167)", () => {
  it("filters deleted_at is null but never merged_into_id — the identity index still needs merged tombstones", async () => {
    const isCalls: Array<[string, unknown]> = [];
    const chain = {
      from: () => chain,
      select: () => chain,
      is: (col: string, v: unknown) => { isCalls.push([col, v]); return chain; },
      order: () => chain,
      range: async () => ({ data: [], error: null }),
    };
    const store = createSupabaseStore(chain as unknown as SupabaseClient<Database>);
    await store.loadPatients();
    expect(isCalls).toEqual([["deleted_at", null]]);
  });
});

/** A client whose rpc() records calls and answers from `reply`. */
function recordingClient(reply: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: reply(fn, args), error: null };
    },
  };
  return { calls, store: createSupabaseStore(client as never) };
}

const items = (n: number): ReviewItemInput[] =>
  Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "ambiguous_patient" : "unparseable_date", item_key: `k${i}`, payload: { i } }));

describe("store.upsertReview — chunked upserts, one set-based clear (0170)", () => {
  it("upserts in REVIEW_CHUNK slices without clearing, then clears once against the whole list", async () => {
    const { calls, store } = recordingClient((fn, args) =>
      fn === "sheet_sync_upsert_review" ? { opened: (args.p_items as unknown[]).length, updated: 1 } : 7);
    const n = REVIEW_CHUNK * 2 + 500;
    const counts = await store.upsertReview("lease", "customers", items(n), true);
    const upserts = calls.filter((c) => c.fn === "sheet_sync_upsert_review");
    expect(upserts.map((c) => (c.args.p_items as unknown[]).length)).toEqual([REVIEW_CHUNK, REVIEW_CHUNK, 500]);
    expect(upserts.every((c) => c.args.p_clear_absent === false)).toBe(true);
    const clears = calls.filter((c) => c.fn === "sheet_sync_clear_absent_review");
    expect(clears).toHaveLength(1);
    expect(calls[calls.length - 1].fn).toBe("sheet_sync_clear_absent_review"); // after every upsert
    expect(clears[0].args.p_present).toHaveLength(n);
    expect((clears[0].args.p_present as Array<Record<string, unknown>>)[1]).toEqual({ kind: "ambiguous_patient", item_key: "k1" });
    expect(counts).toEqual({ opened: n, updated: 3, cleared: 7 });
  });
  it("an empty report still clears (every open item of the tab is absent)", async () => {
    const { calls, store } = recordingClient(() => 3);
    const counts = await store.upsertReview("lease", "lab", [], true);
    expect(calls.map((c) => c.fn)).toEqual(["sheet_sync_clear_absent_review"]);
    expect(counts).toEqual({ cleared: 3 });
  });
  it("no clear call when clearAbsent is false", async () => {
    const { calls, store } = recordingClient(() => ({ opened: 1 }));
    await store.upsertReview("lease", "lab", items(1), false);
    expect(calls.map((c) => c.fn)).toEqual(["sheet_sync_upsert_review"]);
  });
});
