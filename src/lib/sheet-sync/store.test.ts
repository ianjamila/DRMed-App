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
import { createSupabaseStore } from "./store";

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
