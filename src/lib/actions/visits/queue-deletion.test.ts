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
    expect(body).toMatch(/if \(!candidates \|\| candidates\.length === 0\) \{\s*return \{ ok: false, error: NOTHING_TO_DELETE_REFUSAL \};/);
  });

  it("refuses after the read-error handling and before any write", () => {
    const readError = body.indexOf("if (readError)");
    const refusal = body.indexOf("candidates.length === 0");
    const firstWrite = body.indexOf("deleteTestRequestsForVisit(");
    expect(readError).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(readError);
    expect(firstWrite).toBeGreaterThan(refusal);
  });
});
