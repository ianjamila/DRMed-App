import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import type { Database } from "@/types/database";
import { postedCountsByMonth } from "./period-counts";

it("counts beyond 1,000 per month using HEAD, including December's year boundary", async () => {
  const requests: URL[] = [];
  const client = createClient<Database>("https://counts.test", "key", {
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.method).toBe("HEAD");
      expect(new Headers(init?.headers).get("prefer")).toContain("count=exact");
      expect(url.searchParams.get("status")).toBe("eq.posted");
      return new Response(null, { headers: { "content-range": "*/1505" } });
    } },
  });
  const counts = await postedCountsByMonth(client, 2026);
  expect([...counts.values()]).toEqual(Array(12).fill(1505));
  expect(requests).toHaveLength(12);
  expect(requests[0].searchParams.getAll("posting_date")).toEqual(["gte.2026-01-01", "lt.2026-02-01"]);
  expect(requests[11].searchParams.getAll("posting_date")).toEqual(["gte.2026-12-01", "lt.2027-01-01"]);
});

it("does not report a failed month as zero", async () => {
  const client = createClient<Database>("https://counts.test", "key", {
    global: { fetch: async () => new Response(null, { status: 403, statusText: "Forbidden" }) },
  });
  await expect(postedCountsByMonth(client, 2026)).rejects.toThrow();
});
