import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { loadPfWorklists } from "./pf-worklists";

function fixture(failWorklist?: "open" | "pending") {
  const requests: URL[] = [];
  const client = createClient<Database>("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const pending = url.searchParams.get("recognized_at") === "is.null";
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        if (offset > 0 && failWorklist === (pending ? "pending" : "open")) {
          return new Response(JSON.stringify({ message: "chunk failed" }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
        const total = pending ? 2001 : 1203;
        const rows = Array.from({ length: Math.min(limit, total - offset) }, (_, index) => ({
          id: `${pending ? "pending" : "open"}-${offset + index}`,
          pf_php: pending ? 3 : 2,
          physician_id: offset + index >= 1000 ? "later-doctor" : "first-doctor",
        }));
        return new Response(JSON.stringify(rows), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  return { client, requests };
}

describe("PF worklists", () => {
  it("loads every entry for both worklists, including amounts and doctors beyond 1000 rows", async () => {
    const { client, requests } = fixture();
    const { openEntries, pendingHmo } = await loadPfWorklists(client);
    expect(openEntries).toHaveLength(1203);
    expect(pendingHmo).toHaveLength(2001);
    expect(openEntries.reduce((sum, row) => sum + row.pf_php, 0)).toBe(2406);
    expect(pendingHmo.reduce((sum, row) => sum + row.pf_php, 0)).toBe(6003);
    expect(openEntries.filter((row) => row.physician_id === "later-doctor")).toHaveLength(203);
    expect(pendingHmo.filter((row) => row.physician_id === "later-doctor")).toHaveLength(1001);
    expect(new Set(openEntries.map((row) => row.id)).size).toBe(1203);
    expect(new Set(pendingHmo.map((row) => row.id)).size).toBe(2001);

    for (const pending of [false, true]) {
      const pages = requests.filter((url) => (url.searchParams.get("recognized_at") === "is.null") === pending);
      expect(pages.map((url) => url.searchParams.get("offset"))).toEqual(pending ? ["0", "1000", "2000"] : ["0", "1000"]);
      for (const { searchParams: sp } of pages) {
        expect(sp.get("limit")).toBe("1000");
        expect(sp.get("voided_at")).toBe("is.null");
        expect(sp.get("order")).toBe(`${pending ? "created_at" : "recognized_at"}.desc,id.asc`);
        if (pending) {
          expect(sp.get("recognition_basis")).toBe("eq.hmo_at_settlement");
          expect(sp.get("recognized_at")).toBe("is.null");
        } else {
          expect(sp.get("disbursement_id")).toBe("is.null");
          expect(sp.get("recognized_at")).toBe("not.is.null");
          expect(sp.get("select")).toContain("physician_compensation(compensation_arrangement)");
        }
      }
    }
  });

  it.each(["open", "pending"] as const)("rejects a later %s chunk failure rather than displaying partial totals", async (worklist) => {
    const { client } = fixture(worklist);
    await expect(loadPfWorklists(client)).rejects.toThrow("chunk failed");
  });
});
