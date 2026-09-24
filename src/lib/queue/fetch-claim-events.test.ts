import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchClaimEvents } from "./fetch-claim-events";

function fakeClient(fail = false) {
  const calls: string[][] = [];
  const client = {
    rpc: async (_fn: string, args: { p_test_request_ids: string[] }) => {
      calls.push(args.p_test_request_ids);
      if (fail) return { data: null, error: { message: "boom" } };
      return {
        data: args.p_test_request_ids.map((id) => ({
          test_request_id: id,
          action: "test_request.claimed",
          created_at: "2026-09-24T08:00:00.000Z",
          actor_name: "Melvin",
          previous_holder_name: null,
          new_holder_name: null,
          reason: null,
        })),
        error: null,
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("fetchClaimEvents", () => {
  it("makes no call for an empty page", async () => {
    const { client, calls } = fakeClient();
    expect((await fetchClaimEvents(client, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("stays under the function's 200-id cap by chunking, and dedupes ids", async () => {
    const { client, calls } = fakeClient();
    const out = await fetchClaimEvents(client, [...ids(450), "id-0"]);
    expect(calls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(out.size).toBe(450);
  });

  it("degrades a failed read to no remarks instead of throwing", async () => {
    const { client } = fakeClient(true);
    expect((await fetchClaimEvents(client, ids(3))).size).toBe(0);
  });
});
