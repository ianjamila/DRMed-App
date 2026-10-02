import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// deleteTestRequestsManyCore (the bulk bar's Delete body, called by
// deleteQueueSelectionAction in queue/panel-actions.ts; in
// src/lib/actions/queue/bulk-delete-core.ts) has no pure seam (admin client, StaffSession,
// audit()), so — like queue-restore-core.test.ts — it is pinned as source text.
// #254 made a stale all-deleted selection a hard refusal (panel-actions.ts
// relies on the ok:false shape); a merge dropped it and the action went back
// to reporting an empty "success". Lock it in.

const src = readFileSync(join(process.cwd(), "src/lib/actions/queue/bulk-delete-core.ts"), "utf8");
const start = src.indexOf("export async function deleteTestRequestsManyCore");
const end = src.indexOf("\nexport ", start + 1);
const body = src.slice(start, end === -1 ? undefined : end);

describe("deleteTestRequestsManyCore refuses an all-stale selection", () => {
  it("returns ok:false when the candidate read finds no live rows", () => {
    expect(start, "deleteTestRequestsManyCore not found").toBeGreaterThan(-1);
    expect(body).toMatch(/if \(candidates\.length === 0\) \{\s*return \{ ok: false, error: NOTHING_TO_DELETE_REFUSAL \};/);
  });

  it("refuses after the read-error handling and before any write", () => {
    // The candidate read is chunked (readInChunks); a failed slice is a refusal, never an empty set.
    const readError = body.indexOf("if (!read.ok)");
    const refusal = body.indexOf("candidates.length === 0");
    const firstWrite = body.indexOf("deleteTestRequestsForVisit(");
    expect(readError).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(readError);
    expect(firstWrite).toBeGreaterThan(refusal);
  });
});

// 0216: the per-visit delete used to be a bare `.from("test_requests").update(...)`, which locked
// the requested lines (and, through the 0125 cascade, a header's components in heap order) before
// the visit — deadlocking with claim / unclaim / release / undo. It now goes through
// delete_test_request_lines, which takes patient → visit → lines-by-id first.
describe("deleteTestRequestsForVisit writes through delete_test_request_lines (0216)", () => {
  const vStart = src.indexOf("export async function deleteTestRequestsForVisit");
  const vEnd = src.indexOf("\nexport ", vStart + 1);
  const visitBody = src.slice(vStart, vEnd === -1 ? undefined : vEnd);

  it("has no bare test_requests UPDATE left", () => {
    expect(vStart, "deleteTestRequestsForVisit not found").toBeGreaterThan(-1);
    expect(visitBody).not.toMatch(/\.from\("test_requests"\)\s*\.update\(/);
  });

  it("calls the RPC once, retried on a lost race, with the visit, actor, reason and the audited instant", () => {
    const calls = [...visitBody.matchAll(/withLifecycleRetry\(\(\) =>\s*admin\.rpc\("delete_test_request_lines",\s*\{[^}]*\}/g)];
    expect(calls).toHaveLength(1);
    const call = calls[0][0];
    expect(call).toMatch(/p_visit_id:\s*visitId/);
    expect(call).toMatch(/p_actor:\s*session\.user_id/);
    expect(call).toMatch(/p_reason:\s*reason/);
    // The SAME instant rides the audit rows' metadata.deleted_at — a bulk Undo predicates on it.
    expect(call).toMatch(/p_deleted_at:\s*deletedAtIso/);
    expect(visitBody).toMatch(/deleted_at:\s*deletedAtIso,/);
  });
});

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/0216_delete_restore_lock_order.sql"), "utf8");
const deleteFn = SQL.slice(
  SQL.indexOf("create or replace function public.delete_test_request_lines("),
  SQL.indexOf("comment on function public.delete_test_request_lines("),
);

describe("delete_test_request_lines (0216) keeps the app's UPDATE and takes the locks first", () => {
  it("updates only live rows of the requested ids on the visit", () => {
    expect(deleteFn.length).toBeGreaterThan(100);
    expect(deleteFn).toMatch(/where id = any \(p_test_request_ids\)\s+and visit_id = p_visit_id\s+and deleted_at is null/);
  });

  it("patient lock, then visit FOR UPDATE, then the lines by id, then the UPDATE", () => {
    const patient = deleteFn.indexOf("lifecycle_lock_and_assert(array[v_patient], false)");
    const visit = deleteFn.indexOf("where v.id = p_visit_id for update");
    const lines = deleteFn.search(/order by t\.id\s+for no key update/);
    const write = deleteFn.indexOf("update public.test_requests");
    expect(patient).toBeGreaterThan(-1);
    expect(visit).toBeGreaterThan(patient);
    expect(lines).toBeGreaterThan(visit);
    expect(write).toBeGreaterThan(lines);
  });
});
