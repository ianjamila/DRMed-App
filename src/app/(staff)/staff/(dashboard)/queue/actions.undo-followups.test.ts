import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review findings 6 + 7 (P2, 2026-09-30). No pure seam to unit-test
// these DB writes in isolation (admin/RLS clients, audit(), Server Actions) —
// pinned as source text, in the style of
// admin/accounting/hmo-claims/actions.undo-reversal.test.ts. The pure
// planning helpers these call into (partiallyRestoredIds, stillCommittedRows)
// are unit-tested in src/lib/queue/partial-panel.test.ts.

const FILE = join(process.cwd(), "src/app/(staff)/staff/(dashboard)/queue/actions.ts");
const src = readFileSync(FILE, "utf8");

function bodyOf(fnName: string): string {
  const start = src.indexOf(`async function ${fnName}(`);
  expect(start, `${fnName} not found in actions.ts`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport async function ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("finding 6: a bulk-delete Undo that only partially restores a panel compensates the rest back", () => {
  it("undoBulkQueueAction's restore branch checks each pre-validated group for a partial restore via partiallyRestoredIds", () => {
    const body = bodyOf("undoBulkQueueAction");
    expect(body).toMatch(/partiallyRestoredIds\(ids,\s*restoredTestIds\)/);
  });

  it("compensates a partial restore by re-deleting to the batch's recorded deletedAt and the row's PRIOR deleted_by/delete_reason", () => {
    const body = bodyOf("undoBulkQueueAction");
    const at = body.indexOf('.update({\n                deleted_at: step.deletedAt');
    expect(at, "compensation update not found").toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf(".select(\"id\")", at));
    expect(call).toMatch(/deleted_by:\s*prior\?\.deleted_by\s*\?\?\s*null/);
    expect(call).toMatch(/delete_reason:\s*prior\?\.delete_reason\s*\?\?\s*null/);
    // Predicated on the row being currently restored (null) — never blind.
    expect(call).toMatch(/\.eq\("id",\s*id\)/);
    expect(call).toMatch(/\.is\("deleted_at",\s*null\)/);
  });

  it("the pre-validation read that feeds compensation's prior state selects deleted_by and delete_reason", () => {
    const body = bodyOf("undoBulkQueueAction");
    const at = body.indexOf('.select("id, deleted_at, deleted_by, delete_reason, visits ( deleted_at )")');
    expect(at, "pre-validation select not extended with deleted_by/delete_reason").toBeGreaterThan(-1);
  });

  it("audits every successfully compensated (re-deleted) row as test_request.deleted, flagged as a compensation", () => {
    const body = bodyOf("undoBulkQueueAction");
    const auditAt = body.indexOf('action: "test_request.deleted"', body.indexOf("compensatedIds.push"));
    expect(auditAt, "compensation audit row not found after compensatedIds.push").toBeGreaterThan(-1);
    const call = body.slice(auditAt, body.indexOf("});", auditAt));
    expect(call).toMatch(/compensation:\s*true/);
    expect(call).toMatch(/undo_of_batch:\s*parsed\.data\.batchId/);
  });

  it("a group is never marked restoredIds unless every member is still in restoredTestIds — compensated ids are removed from that set", () => {
    const body = bodyOf("undoBulkQueueAction");
    expect(body).toMatch(/restoredTestIds\.delete\(id\)/);
    const finalLoopAt = body.lastIndexOf("ids.every((id) => restoredTestIds.has(id))");
    expect(finalLoopAt).toBeGreaterThan(-1);
  });

  it("a partial group that could not be FULLY compensated back is reported with the shared partial-panel wording, not the generic one", () => {
    expect(src).toMatch(/import \{[\s\S]*?PARTIAL_PANEL_LEFTOVER_REASON[\s\S]*?\} from "@\/lib\/queue\/partial-panel";/);
    const body = bodyOf("undoBulkQueueAction");
    const at = body.indexOf("compensationReasonOf.set(");
    expect(at).toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf(");", at) + 1);
    expect(call).toMatch(/stillLeftover\.length > 0 \? PARTIAL_PANEL_LEFTOVER_REASON : RESTORE_PANEL_CHANGED/);
  });
});

describe("finding 7: auditLeftoverPanelRows fails CLOSED when its verification read errors", () => {
  const at = src.indexOf("async function auditLeftoverPanelRows(");
  const body = src.slice(at, src.indexOf("\nexport type ClaimResult", at));

  it("checks the verification read's error (and null data), not just an empty array", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/const \{ data: fresh, error \} = await supabase/);
    expect(body).toMatch(/if \(error \|\| !fresh\) \{/);
  });

  it("on a failed read, audits EVERY row passed in (not just an empty 'leftover' list) with outcome_unverified", () => {
    const failClosedAt = body.indexOf("if (error || !fresh) {");
    const failClosedBody = body.slice(failClosedAt, body.indexOf("\n  }", failClosedAt));
    expect(failClosedBody).toMatch(/for \(const row of rows\)/);
    expect(failClosedBody).toMatch(/outcome_unverified:\s*true/);
    expect(failClosedBody).toMatch(/return ids;/);
  });

  it("takes rows (with visit_id) rather than bare ids, so the fail-closed path has a visit_id to audit with even when the read never ran", () => {
    expect(body).toMatch(/rows:\s*readonly \{ id: string; visit_id: string \}\[\]/);
  });

  it("every call site passes the full row (id + visit_id), not a bare id array, so fail-closed has what it needs", () => {
    // Only undoBulkQueueAction's reclaim compensation branch calls this now —
    // the bulk claim/unclaim panel loops moved to panel-actions.ts and the
    // Undo's panel un-claim goes through unclaim_panel_members (0191's own
    // atomicity, no app-level compensation left to audit).
    const calls = [...src.matchAll(/auditLeftoverPanelRows\(\s*supabase,\s*([a-zA-Z.()=> ]+),/g)];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const m of calls) {
      expect(m[1].trim()).toBe("got");
    }
  });
});

describe("Task 5: panel Undo un-claims through unclaim_panel_members; reclaim restores each member's own holder", () => {
  const body = bodyOf("undoBulkQueueAction");
  const unclaimBranch = body.slice(body.indexOf('if (kind === "unclaim") {'), body.indexOf('} else if (kind === "reclaim") {'));
  const reclaimBranch = body.slice(body.indexOf('} else if (kind === "reclaim") {'), body.indexOf("// restore"));

  it("the un-claim branch hands a panel group (panelKey !== null) to unclaimPanelMembers, tagged as an Undo of this batch", () => {
    expect(unclaimBranch.length).toBeGreaterThan(0);
    const at = unclaimBranch.indexOf("if (panelKey !== null) {");
    expect(at, "panel gate not found").toBeGreaterThan(-1);
    const panelPath = unclaimBranch.slice(at, unclaimBranch.indexOf("continue;\n        }\n\n        // A single row", at));
    expect(panelPath).toMatch(/await unclaimPanelMembers\(session, supabase, \{/);
    expect(panelPath).toMatch(/holder:\s*session\.user_id/);
    expect(panelPath).toMatch(/via:\s*BULK_UNDO_VIA/);
    expect(panelPath).toMatch(/undo_of_batch:\s*parsed\.data\.batchId/);
    expect(panelPath).toMatch(/bulk_batch_id:\s*undoBatchId/);
    expect(panelPath).toMatch(/panel_key:\s*panelKey/);
    // A refusal (P0077 race) sends the whole panel to notRestored.
    expect(panelPath).toMatch(/if \(!result\.ok\) \{\s*notRestored\.push\(\{ id: group\.key, reason: result\.error \}\)/);
  });

  it("the un-claim branch no longer compensates or audits leftovers (the RPC is all-or-nothing)", () => {
    expect(unclaimBranch).not.toMatch(/auditLeftoverPanelRows/);
    expect(unclaimBranch).not.toMatch(/compensatedCount/);
    expect(unclaimBranch).not.toMatch(/partial_panel/);
  });

  it("the un-claim pre-validation goes through unclaimStepStillHeld, which refuses a null startedAt", () => {
    expect(unclaimBranch).toMatch(/unclaimStepStillHeld\(r, step, session\.user_id\)/);
  });

  it("reclaim writes each member's OWN holder — never the first member's", () => {
    expect(reclaimBranch.length).toBeGreaterThan(0);
    expect(reclaimBranch).not.toMatch(/steps\[0\]!\.holder/);
    expect(reclaimBranch).toMatch(/const holderOf = holderByMember\(steps\)/);
    expect(reclaimBranch).toMatch(/assigned_to:\s*holderOf\.get\(id\)!/);
    expect(reclaimBranch).toMatch(/\.eq\("assigned_to",\s*holderOf\.get\(row\.id\)!\)/);
    expect(reclaimBranch).toMatch(/r\.assigned_to === holderOf\.get\(r\.id\)/);
    expect(reclaimBranch).toMatch(/to:\s*holderOf\.get\(row\.id\) \?\? null/);
  });

  it("reclaim validates every distinct holder's profile and refuses the whole panel with RECLAIM_HOLDER_UNUSABLE", () => {
    expect(reclaimBranch).toMatch(/\.in\("id", distinctHolders\)/);
    expect(reclaimBranch).toMatch(/distinctHolders\.every\(/);
    expect(reclaimBranch).toMatch(/reason: RECLAIM_HOLDER_UNUSABLE/);
    expect(reclaimBranch).toMatch(/canClaimSection\(holderProfileOf\.get\(holderOf\.get\(r\.id\)!\)!\.role/);
  });
});
