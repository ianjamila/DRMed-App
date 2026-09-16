/** Source-query harness: exercise actual loaders without importing an RSC/server-only module.
 * Like the repository's AST query guards, this reads source. Unlike a text assertion,
 * it executes each complete-set expression against supabase-js with a capped transport.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";
import { expect } from "vitest";
import { fetchCompleteRows, fetchCompleteRowsByIds } from "./paging";

export async function checkCompleteQuery(
  file: string,
  index: number,
  bindings: Record<string, unknown> = {},
  options: { failAtOffset?: number } = {},
) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      ["fetchCompleteRows", "fetchCompleteRowsByIds"].includes(node.expression.text)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(calls[index], `complete query ${index} in ${file}`).toBeDefined();
  const rows = Array.from({ length: 1505 }, (_, i) => ({ id: String(i).padStart(6, "0"), amount: 1 }));
  const requests: URL[] = [];
  const client = createClient("https://row-cap.test", "test-key", {
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (options.failAtOffset !== undefined && offset >= options.failAtOffset) {
        return new Response(JSON.stringify({ message: "late page failed" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 1000));
      const ids = url.searchParams.get("id");
      const matching = ids?.startsWith("in.(")
        ? rows.filter((r) => ids.slice(4, -1).split(",").includes(r.id)) : rows;
      return new Response(JSON.stringify(matching.slice(offset, offset + limit)), {
        headers: { "Content-Type": "application/json" },
      });
    } },
  });
  const ids = rows.map((r) => r.id);
  const scope = {
    admin: client, client, supabase: client, fetchCompleteRows, fetchCompleteRowsByIds,
    ids, itemIds: ids, data: { entry_ids: ids, vendor_id: "vendor" },
    parsed: { data: { test_request_ids: ids } },
    providerId: "provider", providerName: "Provider", initialProviderId: "provider", batchId: "batch",
    yearStart: "2026-01-01", yearEnd: "2026-12-31", year: 2026,
    yearStartIso: "2025-12-31T16:00:00Z", yearEndIso: "2026-12-31T16:00:00Z",
    fromIso: "2025-12-31T16:00:00Z", toIso: "2026-12-31T16:00:00Z",
    watermark: "2020-01-01T00:00:00Z", TEST_REQUEST_SELECT: "id",
    DOCTOR_KINDS_PG_LIST: "(doctor_consultation,doctor_procedure)",
    CONSULT_KINDS: ["doctor_consultation"], PROCEDURE_KINDS: ["doctor_procedure"],
    ...bindings,
  };
  const js = ts.transpile(`(${calls[index].getText(source)})`, { target: ts.ScriptTarget.ES2022 });
  // Only repository-owned query expressions are evaluated; no external input.
  const run = new Function(...Object.keys(scope), `return ${js}`);
  const result = await run(...Object.values(scope));
  if (options.failAtOffset !== undefined) {
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("late page failed");
    return requests;
  }
  expect(result.error).toBeNull();
  expect(result.data).toHaveLength(1505);
  expect(new Set(result.data.map((r: { id: string }) => r.id)).size).toBe(1505);
  expect(result.data.reduce((sum: number, r: { amount: number }) => sum + r.amount, 0)).toBe(1505);
  expect(requests.length).toBeGreaterThan(1);
  for (const url of requests) {
    expect(url.searchParams.get("limit")).not.toBeNull();
    expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(1000);
    expect(url.searchParams.get("order")).toMatch(/(?:^|,)(?:id|item_id|test_request_id)\.asc$/);
    const selected = url.searchParams.get("id");
    if (selected?.startsWith("in.(")) expect(selected.split(",").length).toBeLessThanOrEqual(200);
  }
  return requests;
}
