import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Finding 4 (P1, 2026-09-30): undoReleaseBatchAction's whole-report expansion
// could restore a member already rejected as changed-since, or a member this
// batch never released, by pulling it back in through a sibling member's
// combined-report expansion — silently dropping its warning. The fix:
//   1. releaseSelectedAction now stamps the exact `released_at` it wrote into
//      each release audit row's metadata.
//   2. undoReleaseBatchAction expands candidateIds to whole-report membership
//      BEFORE calling the shared core, and refuses (routes to notRestored)
//      every member of a report where any member is changed-since or was not
//      released by this exact batch.
//   3. The shared core (undoReleasedRows) accepts an optional
//      `expectedReleasedAtOf` map and, when given, predicates its UPDATE on
//      the EXACT released_at each id's audit row recorded — one UPDATE per
//      distinct value — so it can only ever reverse the release it read
//      back. The manual (`undoReleaseSelectedAction`) and sample-visit-delete
//      paths never pass this map, so their write stays byte-for-byte what it
//      was before this fix.
// This is a full Server Action (RLS-scoped client, audit(), headers(),
// requireActiveStaff()) with no pure seam to unit-test the DB calls in
// isolation, so — following actions.undo-reversal.test.ts's pattern in the
// hmo-claims folder — this pins the source text. The decision logic itself
// (reportsToRefuse, groupIdsByExpectedReleasedAt) is unit-tested with real
// inputs in src/lib/visits/undo-release-scope.test.ts.

const ACTIONS_FILE = join(
  process.cwd(),
  "src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts",
);
const src = readFileSync(ACTIONS_FILE, "utf8");

function bodyOf(fnName: string): string {
  const marker = new RegExp(`(?:export )?async function ${fnName}\\(`);
  const match = marker.exec(src);
  expect(match, `${fnName} not found in actions.ts`).not.toBeNull();
  const start = match!.index;
  // Up to the next top-level function declaration (or EOF) is generous
  // enough for a single-function slice in this file's layout.
  const rest = src.slice(start + 1);
  const nextOffset = rest.search(/\n(?:export )?async function /);
  return nextOffset === -1 ? src.slice(start) : src.slice(start, start + 1 + nextOffset);
}

describe("releaseSelectedAction stamps the release identity Undo later reads back", () => {
  it("includes released_at: now in the test_request.released audit metadata", () => {
    const body = bodyOf("releaseSelectedAction");
    const auditAt = body.indexOf('action: "test_request.released"');
    expect(auditAt).toBeGreaterThan(-1);
    const metaSlice = body.slice(auditAt, auditAt + 600);
    expect(metaSlice).toMatch(/bulk_batch_id:\s*batchId,/);
    expect(metaSlice).toMatch(/released_at:\s*now,/);
  });
});

describe("undoReleaseBatchAction refuses whole reports before calling the shared core", () => {
  const body = bodyOf("undoReleaseBatchAction");

  it("computes reportsToRefuse before invoking the shared core", () => {
    const refuseAt = body.indexOf("reportsToRefuse(");
    const coreCallAt = body.indexOf("await undoReleasedRows(");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(coreCallAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(coreCallAt);
  });

  it("passes batchReleasedIds and changedSinceIds into reportsToRefuse", () => {
    const refuseAt = body.indexOf("reportsToRefuse(");
    const argsSlice = body.slice(refuseAt, refuseAt + 300);
    expect(argsSlice).toMatch(/batchReleasedIds,/);
    expect(argsSlice).toMatch(/changedSinceIds:\s*loaded\.changedSince,/);
  });

  it("filters candidateIds down to scopedCandidateIds before the core call", () => {
    const coreCallAt = body.indexOf("await undoReleasedRows(");
    const callSlice = body.slice(coreCallAt, coreCallAt + 400);
    expect(callSlice).toMatch(/scopedCandidateIds,/);
  });

  it("passes expectedReleasedAtOf into the shared core", () => {
    const coreCallAt = body.indexOf("await undoReleasedRows(");
    const callSlice = body.slice(coreCallAt, coreCallAt + 500);
    expect(callSlice).toMatch(/expectedReleasedAtOf,/);
  });

  it("fails closed (refuses the whole undo) when the pre-check expansion read fails", () => {
    const expansionAt = body.indexOf("await loadReportExpansion(");
    expect(expansionAt).toBeGreaterThan(-1);
    const afterExpansion = body.slice(expansionAt, expansionAt + 400);
    expect(afterExpansion).toMatch(/if \(!expansionResult\.ok\) return \{ ok: false, error: expansionResult\.error \};/);
  });
});

describe("the manual and sample-visit undo paths never pass expectedReleasedAtOf", () => {
  it.each(["undoReleaseSelectedAction", "deleteSampleVisitAction"])(
    "%s calls the shared core with no released_at scoping",
    (fnName) => {
      const body = bodyOf(fnName);
      const callAt = body.indexOf("undoReleasedRows(");
      expect(callAt, `${fnName} does not call undoReleasedRows`).toBeGreaterThan(-1);
      const closeAt = body.indexOf(");", callAt);
      expect(closeAt).toBeGreaterThan(callAt);
      const callText = body.slice(callAt, closeAt);
      expect(callText).not.toMatch(/expectedReleasedAtOf/);
    },
  );
});

describe("undoReleasedRows scopes its write to the exact release only when expectedReleasedAtOf is given", () => {
  const body = bodyOf("undoReleasedRows");

  it("groups ids by their expected released_at and predicates the UPDATE on it", () => {
    expect(body).toMatch(/groupIdsByExpectedReleasedAt\(updateIds, expectedReleasedAtOf\)/);
    expect(body).toMatch(/\.eq\("released_at", group\.releasedAt\)/);
  });

  it("keeps the manual-path write a single UPDATE over updateIds with no released_at predicate", () => {
    // The `else` branch (expectedReleasedAtOf absent/empty) must stay the
    // same shape as before this fix: one UPDATE over `updateIds`, no
    // released_at eq — byte-for-byte for undoReleaseSelectedAction and
    // deleteSampleVisitAction.
    const elseAt = body.indexOf("} else {");
    expect(elseAt).toBeGreaterThan(-1);
    const errorCheckAt = body.indexOf("if (error) return", elseAt);
    expect(errorCheckAt).toBeGreaterThan(elseAt);
    const elseBlock = body.slice(elseAt, errorCheckAt);
    expect(elseBlock).toMatch(/\.in\("id", updateIds\)/);
    expect(elseBlock).not.toMatch(/released_at/);
  });

  it("only takes the released_at-scoped branch when the map is non-empty", () => {
    expect(body).toMatch(/if \(expectedReleasedAtOf && expectedReleasedAtOf\.size > 0\)/);
  });
});
