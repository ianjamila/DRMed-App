import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchClaimEvents } from "./fetch-claim-events";

type Call = { fn: string; ids: string[] };

function fakeClient(fail = false) {
  const calls: Call[] = [];
  const client = {
    rpc: async (fn: string, args: { p_test_request_ids: string[] }) => {
      calls.push({ fn, ids: args.p_test_request_ids });
      if (fail) return { data: null, error: { message: "boom" } };
      const edit = fn === "result_amendment_remarks";
      return {
        data: args.p_test_request_ids.map((id) => ({
          test_request_id: id,
          action: edit ? "result.amended" : "test_request.claimed",
          created_at: edit ? "2026-09-25T08:00:00.000Z" : "2026-09-24T08:00:00.000Z",
          actor_name: "Melvin",
          previous_holder_name: null,
          new_holder_name: null,
          reason: edit ? "wrong unit" : null,
        })),
        error: null,
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
const sizes = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.ids.length);

describe("fetchClaimEvents", () => {
  it("makes no call for an empty page", async () => {
    const { client, calls } = fakeClient();
    expect((await fetchClaimEvents(client, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("stays under both functions' 200-id cap by chunking, and dedupes ids", async () => {
    const { client, calls } = fakeClient();
    const out = await fetchClaimEvents(client, [...ids(450), "id-0"]);
    expect(sizes(calls, "queue_claim_remarks")).toEqual([200, 200, 50]);
    expect(sizes(calls, "result_amendment_remarks")).toEqual([200, 200, 50]);
    expect(out.size).toBe(450);
  });

  it("merges claims and edits per test", async () => {
    const { client } = fakeClient();
    const out = await fetchClaimEvents(client, ["t1"]);
    expect(out.get("t1")?.map((e) => e.action).sort()).toEqual(["result.amended", "test_request.claimed"]);
  });

  it("skips the edit reader when the caller only needs claims (the Visit page)", async () => {
    const { client, calls } = fakeClient();
    const out = await fetchClaimEvents(client, ["t1"], { includeEdits: false });
    expect(calls.map((c) => c.fn)).toEqual(["queue_claim_remarks"]);
    expect(out.get("t1")?.map((e) => e.action)).toEqual(["test_request.claimed"]);
  });

  it("degrades a failed read to no remarks instead of throwing", async () => {
    const { client } = fakeClient(true);
    expect((await fetchClaimEvents(client, ids(3))).size).toBe(0);
  });
});
