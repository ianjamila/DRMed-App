import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-text pins for undoBulkQueueAction's panel paths. The behaviour
// itself (rows, audits, refusals, races) is pinned end to end against a fake
// client in actions.undo-behaviour.test.ts; what reads better as text is
// "which helper does this branch call, and is the compensation machinery gone"
// — a panel's Undo is atomic in the database now (0191 / 0200), so the
// member-by-member write, the compensating revert/re-delete and the
// leftover-audit helper must not creep back.

const FILE = join(process.cwd(), "src/app/(staff)/staff/(dashboard)/queue/actions.ts");
const src = readFileSync(FILE, "utf8");

function bodyOf(fnName: string): string {
  const start = src.indexOf(`async function ${fnName}(`);
  expect(start, `${fnName} not found in actions.ts`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport async function ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("a panel's Undo is atomic in the database — no compensation machinery is left", () => {
  const body = bodyOf("undoBulkQueueAction");

  it("the compensation helpers and their wording are gone from actions.ts", () => {
    expect(src).not.toMatch(/auditLeftoverPanelRows/);
    expect(src).not.toMatch(/partial-panel/);
    expect(src).not.toMatch(/PARTIAL_PANEL_LEFTOVER_REASON|stillCommittedRows|partiallyRestoredIds/);
    expect(body).not.toMatch(/compensatedIds|compensatedCount|compensationReasonOf|compensation: true/);
    expect(body).not.toMatch(/partial_panel/);
  });

  it("the restore branch hands a panel to restorePanelMembers only AFTER assertVisitPatientActive, and the panel's refusal reason is what the operator sees", () => {
    const at = body.indexOf("for (const group of panelGroups) {");
    expect(at, "panel restore loop not found").toBeGreaterThan(-1);
    const loop = body.slice(at, body.indexOf("if (restoredTestIds.size > 0) anyChanged = true;", at));
    const guard = loop.indexOf("await assertVisitPatientActive(admin, visitId)");
    const write = loop.indexOf("await restorePanelMembers(session, admin, {");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
    expect(loop).toMatch(/deletedAt:\s*s\.deletedAt!/);
    expect(loop).toMatch(/panelReasonOf\.set\(group\.key, active\.error\)/);
    expect(loop).toMatch(/panelReasonOf\.set\(group\.key, result\.error\)/);
  });

  it("singles still restore through restoreTestRequestsForVisit with the exact deleted_at map", () => {
    expect(body).toMatch(/await restoreTestRequestsForVisit\(\s*session,\s*visitId,\s*ids,[\s\S]*?expectedDeletedAtOf,?\s*\)/);
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

  it("reclaim writes each member's OWN holder — never the first member's — through reclaimPanelMembers / the exact-predicate single write", () => {
    expect(reclaimBranch.length).toBeGreaterThan(0);
    expect(reclaimBranch).not.toMatch(/steps\[0\]!\.holder/);
    expect(reclaimBranch).toMatch(/const holderOf = holderByMember\(steps\)/);
    expect(reclaimBranch).toMatch(/await reclaimPanelMembers\(session, supabase, \{/);
    expect(reclaimBranch).toMatch(/holder:\s*holderOf\.get\(id\)!,\s*startedAt:\s*startedAtOf\.get\(id\)\s*\?\?\s*null/);
    expect(reclaimBranch).toMatch(/assigned_to:\s*holderOf\.get\(id\)!/);
    expect(reclaimBranch).toMatch(/to:\s*holderOf\.get\(data\.id\) \?\? null/);
    expect(reclaimBranch).toMatch(/via:\s*BULK_UNDO_VIA/);
    expect(reclaimBranch).toMatch(/panel_key:\s*steps\[0\]!\.panelKey/);
    // a refusal (P0082) sends the whole panel to notRestored
    expect(reclaimBranch).toMatch(/if \(!result\.ok\) \{\s*notRestored\.push\(\{ id: group\.key, reason: result\.error \}\)/);
  });

  it("the single-row writes (un-claim and re-claim) retry a lost lifecycle race once", () => {
    expect(unclaimBranch).toMatch(/await withLifecycleRetry\(\(\) =>\s*supabase\s*\.from\("test_requests"\)\s*\.update\(\{ status: "requested"/);
    expect(reclaimBranch).toMatch(/await withLifecycleRetry\(\(\) =>\s*supabase\s*\.from\("test_requests"\)\s*\.update\(\{\s*status: "in_progress"/);
  });

  it("reclaim validates every distinct holder's profile and refuses the whole panel with RECLAIM_HOLDER_UNUSABLE", () => {
    expect(reclaimBranch).toMatch(/\.in\("id", distinctHolders\)/);
    expect(reclaimBranch).toMatch(/distinctHolders\.every\(/);
    expect(reclaimBranch).toMatch(/reason: RECLAIM_HOLDER_UNUSABLE/);
    expect(reclaimBranch).toMatch(/canClaimSection\(holderProfileOf\.get\(holderOf\.get\(r\.id\)!\)!\.role/);
  });
});

describe("the Undo message counts TESTS, not selection keys", () => {
  it("undoBulkQueueAction returns restoredTestCount summed over the restored groups by restoredTestCountOf", () => {
    const body = bodyOf("undoBulkQueueAction");
    expect(body).toMatch(
      /return \{ ok: true, restoredIds, restoredTestCount: restoredTestCountOf\(groups, restoredIds\), notRestored \};/,
    );
  });
});

describe("the Undo role gate runs before the batch is read", () => {
  it("refuses a role that can do none of Claim / Unclaim / Delete before loadOwnBatchRows (admin client, un-scoped reads) is called", () => {
    const body = bodyOf("undoBulkQueueAction");
    const gate = body.search(
      /!\(LAB_CAPABLE_ROLES as readonly string\[\]\)\.includes\(session\.role\) && !QUEUE_DELETE_ROLES\.has\(session\.role\)\) \{\s*return \{ ok: false, error: UNDO_ROLE_CHANGED \};/,
    );
    const read = body.indexOf("await loadOwnBatchRows(");
    expect(gate, "role gate not found").toBeGreaterThan(-1);
    expect(read, "loadOwnBatchRows call not found").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(read);
    // ...and after the session, not before it.
    expect(body.indexOf("await requireActiveStaff()")).toBeLessThan(gate);
  });
});
