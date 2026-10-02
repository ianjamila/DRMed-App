import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review finding 3 (P1, 2026-09-30): restoreTestRequestsForVisit used to
// filter the READ by the exact deleted_at a bulk Undo expected (sameInstant),
// but predicate the WRITE only on "deleted_at is not null" — so a
// restore-and-re-delete landing between the read and the write still matched
// that looser predicate and got silently undone by an Undo that had nothing
// to do with it. The fix groups the validated rows by the exact deleted_at
// value read (groupIdsByDeletedAt, src/lib/queue/partial-panel.ts — its own
// grouping logic is unit-tested there) and issues one write per group, each
// predicated on that exact value (since 0216: restore_test_request_lines with
// p_deleted_at). restoreTestRequestsForVisit
// itself has no pure seam (admin client, StaffSession, audit()) — pinned here
// as source text.

const FILE = join(process.cwd(), "src/lib/actions/visits/queue-restore-core.ts");
const src = readFileSync(FILE, "utf8");

describe("restoreTestRequestsForVisit's bulk-Undo write predicates on the exact deleted_at read, not just NOT NULL", () => {
  it("groups the expectedDeletedAtOf branch's rows via groupIdsByDeletedAt", () => {
    expect(src).toMatch(/import \{ groupIdsByDeletedAt \} from "@\/lib\/queue\/partial-panel";/);
    expect(src).toMatch(/groupIdsByDeletedAt\(/);
  });

  it("the expectedDeletedAtOf branch writes with the exact value, never merely NOT NULL", () => {
    const branchStart = src.indexOf("if (expectedDeletedAtOf) {", src.indexOf("let restored:"));
    expect(branchStart, "expectedDeletedAtOf write branch not found").toBeGreaterThan(-1);
    const branchEnd = src.indexOf("\n  } else {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/rpc\("restore_test_request_lines",\s*\{[^}]*p_deleted_at:\s*deletedAtValue/);
  });

  it("the manual-restore (no expectedDeletedAtOf) branch passes no p_deleted_at (the function then restores any deleted row)", () => {
    const elseStart = src.indexOf("\n  } else {", src.indexOf("let restored:"));
    expect(elseStart).toBeGreaterThan(-1);
    const elseEnd = src.indexOf("\n  }\n\n  const rowById", elseStart);
    expect(elseEnd).toBeGreaterThan(elseStart);
    const branch = src.slice(elseStart, elseEnd);
    const call = branch.match(/rpc\("restore_test_request_lines",\s*\{[^}]*\}/);
    expect(call, "manual-restore rpc call not found").not.toBeNull();
    expect(call![0]).not.toMatch(/p_deleted_at/);
    expect(branch).not.toMatch(/groupIdsByDeletedAt/);
  });

  it("every write in both branches goes through restore_test_request_lines (0216), scoped to the visit and retried once", () => {
    // 0216: a bare UPDATE locked the line before the visit and deadlocked with
    // release / undo; losing p_visit_id would let a same-batch id belonging to
    // a DIFFERENT visit slip through the write.
    expect(src).not.toMatch(/\.from\("test_requests"\)\s*\.update\(/);
    const writes = [...src.matchAll(/withLifecycleRetry\(\(\) =>\s*admin\.rpc\("restore_test_request_lines",\s*\{[^}]*\}/g)];
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w[0]).toMatch(/p_visit_id:\s*visitId/);
  });
});

// The predicates themselves now live in SQL: pin them in the migration that defines the function.
const SQL = readFileSync(join(process.cwd(), "supabase/migrations/0216_delete_restore_lock_order.sql"), "utf8");
const restoreFn = SQL.slice(
  SQL.indexOf("create or replace function public.restore_test_request_lines("),
  SQL.indexOf("comment on function public.restore_test_request_lines("),
);

describe("restore_test_request_lines (0216) keeps the app's write predicates", () => {
  it("exact deleted_at with p_deleted_at, NOT NULL without it, always on the visit", () => {
    expect(restoreFn.length).toBeGreaterThan(100);
    expect(restoreFn).toMatch(/\(\(p_deleted_at is null and deleted_at is not null\) or deleted_at = p_deleted_at\)/);
    expect(restoreFn).toMatch(/and visit_id = p_visit_id/);
  });
});
