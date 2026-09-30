// Reads migration 0194 as text (no database), like
// claim-holder-guard-migration.test.ts. Pins what could silently drift:
//   (a) the searchable fields match the queue's old haystack;
//   (b) both live-row predicates, on the row AND on panel siblings;
//   (c) siblings share the row's tab bucket;
//   (d) the relationship function has NO `set` clause (a SET blocks Postgres
//       from inlining it — measured 1.2 s vs 0.2 s on prod) and is sql/stable;
//   (e) ACLs: view invoker-rights, closed to anon; function closed to
//       public/anon, open to authenticated + service_role.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0194_lab_search.sql"),
  "utf8",
).replace(/--.*$/gm, ""); // strip comments so prose can't satisfy a pin

const view = sql.slice(
  sql.indexOf("create view public.lab_search_rows"),
  sql.indexOf("create function public.lab_search("),
);
const fn = sql.slice(
  sql.indexOf("create function public.lab_search("),
  sql.indexOf("$$;", sql.indexOf("create function public.lab_search(")),
);

describe("0194_lab_search.sql", () => {
  it("(a) searches name, DRM-ID, visit #, test and report group", () => {
    for (const field of [
      "p.last_name", "p.first_name", "p.drm_id", "v.visit_number",
      "s.code", "s.name", "rg.code", "rg.name", "s2.code", "s2.name",
    ]) {
      expect(view, field).toContain(field);
    }
  });

  it("(b) keeps only live rows, and only live panel siblings", () => {
    expect(view).toContain("tr.deleted_at is null");
    expect(view).toContain("v.deleted_at is null");
    expect(view).toContain("t2.deleted_at is null");
    expect(view).toContain("t2.id <> tr.id");
    expect(view).toContain("s2.report_group_id = s.report_group_id");
  });

  it("(c) siblings share the row's tab bucket", () => {
    expect(view).toContain(
      "(case when t2.status in ('requested', 'in_progress') then 'bench' else t2.status end)",
    );
    expect(view).toContain(
      "(case when tr.status in ('requested', 'in_progress') then 'bench' else tr.status end)",
    );
  });

  it("(c2) a released sibling counts only on the same result file as the row", () => {
    // Mirrors newestLinkWithPdf (src/lib/results/pdf-availability.ts): the
    // Released tab splits a panel into one card per file (reportCardKey).
    expect(view).toContain("tr.status <> 'released' or (");
    expect(view).toContain("where l2.test_request_id = t2.id");
    expect(view).toContain("where l1.test_request_id = tr.id");
    expect(view).toContain("order by l2.created_at desc, l2.result_id");
    expect(view).toContain("order by l1.created_at desc, l1.result_id");
    expect(view).toContain("case when r2.storage_path is not null then l2.result_id end");
    expect(view).toContain("case when r1.storage_path is not null then l1.result_id end");
    expect(view).toContain(") is not distinct from (");
  });

  it("(d) the relationship is an inlinable sql function over the view", () => {
    expect(fn).toContain("returns setof public.lab_search_rows");
    expect(fn).toContain("rows 1");
    expect(fn).toContain("language sql");
    expect(fn).toContain("stable");
    expect(fn).not.toMatch(/\bset\s+search_path\b/);
    expect(fn).not.toContain("security definer");
    expect(fn).toContain("where r.test_request_id = $1.id");
  });

  it("(e) ACLs are restated", () => {
    expect(view).toContain("with (security_invoker = on)");
    expect(sql).toContain("revoke all on public.lab_search_rows from anon, authenticated;");
    expect(sql).toContain("grant select on public.lab_search_rows to authenticated, service_role;");
    expect(sql).toContain(
      "revoke execute on function public.lab_search(public.test_requests) from public, anon;",
    );
    expect(sql).toContain(
      "grant execute on function public.lab_search(public.test_requests) to authenticated, service_role;",
    );
  });
});
