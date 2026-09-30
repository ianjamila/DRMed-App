import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// countResultViews (viewed-count.ts) has a SQL twin since 0205:
// result_view_count(), which undo_visit_release calls under its row locks to
// stamp viewed_count on each test_request.release_undone audit row. The visit
// page / undo dialog show the TS count and the audit row stores the SQL one,
// so the two must match the SAME historical shapes of a `result.downloaded`
// row. This pins both texts; a new shape added to one must be added to both.
const ts = readFileSync(join(process.cwd(), "src/lib/results/viewed-count.ts"), "utf8");
const sql = (() => {
  const text = readFileSync(
    join(process.cwd(), "supabase/migrations/0205_release_audit_in_rpc.sql"),
    "utf8",
  );
  const start = text.indexOf("create or replace function public.result_view_count");
  const end = text.indexOf("$$;", start);
  return text.slice(start, end);
})();

describe("countResultViews ↔ result_view_count (0205)", () => {
  it("both read result.downloaded rows of resource_type result", () => {
    expect(ts).toContain('.eq("action", "result.downloaded")');
    expect(ts).toContain('.eq("resource_type", "result")');
    expect(sql).toContain("a.action = 'result.downloaded'");
    expect(sql).toContain("a.resource_type = 'result'");
  });

  it("both match the same four shapes", () => {
    // (1) metadata.test_request_id
    expect(ts).toContain('"metadata->>test_request_id"');
    expect(sql).toContain("a.metadata ->> 'test_request_id' = p_test_request_id::text");
    // (2) resource_id = a result linked to the test
    expect(ts).toMatch(/from\("result_test_requests"\)[\s\S]*\.in\("resource_id", resultIds\)/);
    expect(sql).toMatch(/a\.resource_id in \(select rtr\.result_id\s+from public\.result_test_requests rtr/);
    // (3) metadata.merged_component_ids contains it
    expect(ts).toContain('"metadata->merged_component_ids"');
    expect(sql).toContain("a.metadata -> 'merged_component_ids' @> jsonb_build_array(p_test_request_id::text)");
    // (4) normalized metadata.test_request_ids contains it
    expect(ts).toContain('"metadata->test_request_ids"');
    expect(sql).toContain("a.metadata -> 'test_request_ids' @> jsonb_build_array(p_test_request_id::text)");
  });

  it("both count each audit row once (the shapes overlap)", () => {
    expect(ts).toContain("const ids = new Set<number>()");
    // One row per audit_log row: a single scan with OR'd shapes, no join fan-out.
    expect(sql).toMatch(/select count\(\*\)::integer\s+from public\.audit_log a\s+where/);
    expect(sql).not.toMatch(/\bjoin\b/i);
  });
});
