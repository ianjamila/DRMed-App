import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { HISTORY_SORTABLE, loadPfHistory, parsePfHistoryParams } from "./pf-history";

describe("PF history window", () => {
  it("preserves the default 90 Manila calendar days, including at year boundaries", () => {
    expect(parsePfHistoryParams({}, "2026-01-01")).toMatchObject({ start: "2025-10-03", end: null, page: 1, size: 25 });
  });
  it("accepts a shareable multi-year date range", () => {
    expect(parsePfHistoryParams({ start: "2020-01-01", end: "2026-09-16" }, "2026-09-16")).toMatchObject({ start: "2020-01-01", end: "2026-09-16" });
  });
  it("normalizes reversed ranges", () => {
    expect(parsePfHistoryParams({ start: "2026-09-16", end: "2020-01-01" }, "2026-09-16")).toMatchObject({ start: "2020-01-01", end: "2026-09-16" });
  });
  it("rejects invalid dates and unsafe sort/size params", () => {
    expect(parsePfHistoryParams({ start: "junk", end: "junk", sort: "id;drop table", size: "99999" }, "2026-09-16")).toMatchObject({ start: "2026-06-18", end: null, sort: { key: "posted_date", dir: "desc" }, size: 25 });
  });
  it.each(["2026-02-30", "2026-13-01", "0000-01-01"])("rejects impossible calendar dates: %s", (date) => {
    expect(parsePfHistoryParams({ start: date, end: date }, "2026-09-16")).toMatchObject({ start: "2026-06-18", end: null });
  });
});

describe("PF history database paging", () => {
  function fixture(total = 1203) {
    const requests: { url: URL; method: string | undefined }[] = [];
    const client = createClient<Database>("https://example.supabase.co", "test-key", {
      global: { fetch: async (input, init) => {
        requests.push({ url: new URL(String(input)), method: init?.method });
        return new Response(init?.method === "HEAD" ? null : "[]", {
          headers: { "content-type": "application/json", "content-range": `0-0/${total}` },
        });
      } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return { client, requests };
  }
  it.each(HISTORY_SORTABLE)("orders %s on the server with a direction-independent id tie-break", async (sort) => {
    for (const dir of ["asc", "desc"] as const) {
      const { client, requests } = fixture();
      const result = await loadPfHistory(client, parsePfHistoryParams({ start: "2020-01-01", end: "2026-09-16", sort, dir, page: "2" }, "2026-09-16"));
      expect(result.state.total).toBe(1203);
      expect(requests[0].method).toBe("HEAD");
      for (const { url } of requests) expect(url.searchParams.getAll("posted_date")).toEqual(["gte.2020-01-01", "lte.2026-09-16"]);
      const query = requests[1].url.searchParams;
      expect(query.get("offset")).toBe("25");
      expect(query.get("limit")).toBe("25");
      expect(query.get("order")).toBe(`${sort === "physician" ? "physicians(full_name)" : sort}.${dir}.nullslast,id.asc`);
    }
  });
  it("clamps a stale page using the full count", async () => {
    const { client, requests } = fixture(51);
    const result = await loadPfHistory(client, parsePfHistoryParams({ page: "999" }, "2026-09-16"));
    expect(result.state.page).toBe(3);
    expect(requests[1].url.searchParams.get("offset")).toBe("50");
  });
});
