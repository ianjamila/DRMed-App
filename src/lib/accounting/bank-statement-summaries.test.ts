import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { loadBankStatementSummaries } from "./bank-statement-summaries";

function fixture(fail?: "parents" | "children") {
  const statements = Array.from({ length: 1203 }, (_, i) => ({
    id: `s${String(i).padStart(4, "0")}`, period_start: "2026-01-01", uploaded_at: "2026-02-01",
  }));
  // One statement alone exceeds the nested-response cap. Remaining parents
  // also exercise fan-out and the last of more than six 200-ID chunks.
  const lines = [
    ...Array.from({ length: 1505 }, (_, i) => ({
      id: `a${String(i).padStart(4, "0")}`, statement_id: statements[0].id,
      matched_je_line_id: i < 1200 ? `matched-${i}` : null, amount_php: i % 2 ? -1 : 3,
    })),
    ...statements.slice(1).map((s, i) => ({
      id: `b${String(i).padStart(4, "0")}`, statement_id: s.id, matched_je_line_id: null, amount_php: 5,
    })),
  ];
  const requests: URL[] = [];
  const client = createClient<Database>("https://bank-summary.test", "test", { global: { fetch: async (input) => {
    const url = new URL(String(input)); requests.push(url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 1000));
    const isParent = url.pathname.endsWith("/bank_statements");
    if (offset === 1000 && fail === (isParent ? "parents" : "children")) {
      return new Response(JSON.stringify({ message: "later page unavailable" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const ids = url.searchParams.get("statement_id")?.slice(4, -1).split(",") ?? [];
    const matching = isParent ? statements : lines.filter((line) => ids.includes(line.statement_id));
    return new Response(JSON.stringify(matching.slice(offset, offset + limit)), {
      headers: { "Content-Type": "application/json" },
    });
  } } });
  return { client, requests };
}

describe("bank statement summaries", () => {
  it("includes >1,000 parents, uncapped children and every 200-ID chunk in totals", async () => {
    const { client, requests } = fixture();
    const rows = await loadBankStatementSummaries(client);
    expect(rows).toHaveLength(1203);
    expect(rows[0].summary).toEqual({ total: 1505, matched: 1200, net: 1507 });
    expect(rows.at(-1)?.summary).toEqual({ total: 1, matched: 0, net: 5 });
    expect(rows.reduce((n, row) => n + row.summary.total, 0)).toBe(2707);
    const parents = requests.filter((u) => u.pathname.endsWith("/bank_statements"));
    expect(parents).toHaveLength(2);
    for (const u of parents) {
      expect(u.searchParams.get("select")).not.toContain("bank_statement_lines");
      expect(u.searchParams.get("order")).toBe("period_start.desc,uploaded_at.desc,id.asc");
    }
    const children = requests.filter((u) => u.pathname.endsWith("/bank_statement_lines"));
    expect(children.some((u) => u.searchParams.get("offset") === "1000")).toBe(true);
    for (const u of children) {
      expect(u.searchParams.get("statement_id")?.slice(4, -1).split(",").length).toBeLessThanOrEqual(200);
      expect(u.searchParams.get("order")).toBe("id.asc");
    }
  });
  it.each(["parents", "children"] as const)("fails visibly on a later %s page", async (part) => {
    await expect(loadBankStatementSummaries(fixture(part).client)).rejects.toThrow("later page unavailable");
  });
});
