import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review findings 1 + 2 (2026-09-30): a concurrent Undo of the same
// historic claim could reverse the same posted JE twice (the posted→draft
// transition in journal-entry.ts used to be unconditional), and a discarded
// lookup error there read identically to "nothing to reverse", so a failed
// lookup let this action restore the claim row while the original JE stayed
// posted. Both are pinned below: this file's call must pass
// `expectedEntryId` (so a reversal that doesn't match what this action just
// re-verified is refused rather than silently accepted), and journal-entry.ts
// itself must make the status transition conditional and never drop the
// lookup's error.
const JOURNAL_ENTRY_FILE = join(
  process.cwd(),
  "src/lib/accounting/journal-entry.ts",
);
const journalEntrySrc = readFileSync(JOURNAL_ENTRY_FILE, "utf8");

// 10-minute Undo (owner 2026-09-28): Mark paid / Write off undo must reverse
// the JE through the ledger's reversal pairs (reverseJournalEntryBySource —
// original marked 'reversed', a mirror posted, so reports net to zero, per
// CLAUDE.md's "Ledger totals count posted + reversed" rule) rather than
// deleting or otherwise mutating a posted journal_entries row directly. This
// pins the source text since undoHistoricHmoBatchAction is a full Server
// Action (admin client, audit(), headers()) with no pure seam to unit-test
// the DB calls in isolation.

const ACTIONS_FILE = join(
  process.cwd(),
  "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts",
);
const src = readFileSync(ACTIONS_FILE, "utf8");

function bodyOf(fnName: string): string {
  const start = src.indexOf(`export async function ${fnName}(`);
  expect(start, `${fnName} not found in actions.ts`).toBeGreaterThan(-1);
  // Up to the next top-level "export async function" (or EOF) is generous
  // enough for a single-function slice in this file's layout.
  const next = src.indexOf("\nexport async function ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("undoHistoricHmoBatchAction reverses the JE through the ledger, not around it", () => {
  const body = bodyOf("undoHistoricHmoBatchAction");

  it("calls reverseJournalEntryBySource for the paid/write-off restore path", () => {
    expect(body).toMatch(/reverseJournalEntryBySource\(\s*admin\s*,\s*\{/);
    expect(body).toMatch(/sourceKind:\s*"history_import"/);
  });

  it("never deletes or force-posts a journal_entries row as part of the reversal", () => {
    // A posted-only delete/force-update would silently discard the paired
    // reversal the ledger-status guard depends on (0173).
    expect(body).not.toMatch(/from\("journal_entries"\)[\s\S]{0,80}\.delete\(/);
    expect(body).not.toMatch(/status:\s*"posted"/);
  });

  it("checks the claim's current state before reversing, so a stale batch can't reverse the wrong entry", () => {
    const reverseAt = body.indexOf("reverseJournalEntryBySource(");
    const stillValidAt = body.indexOf("stillValid");
    expect(stillValidAt).toBeGreaterThan(-1);
    expect(stillValidAt).toBeLessThan(reverseAt);
  });

  it("pins the reversal to the exact JE it just re-verified via expectedEntryId", () => {
    const reverseAt = body.indexOf("reverseJournalEntryBySource(");
    expect(reverseAt).toBeGreaterThan(-1);
    const callEnd = body.indexOf(");", reverseAt);
    const call = body.slice(reverseAt, callEnd);
    expect(call).toMatch(/expectedEntryId:\s*step\.journalEntryId/);
  });
});

describe("reverseJournalEntryBySource itself closes the race + swallowed-error gaps (journal-entry.ts)", () => {
  it("claims the posted->draft transition conditionally, not unconditionally", () => {
    // The update that flips the original entry to 'draft' must be predicated
    // on status = 'posted' AND its result checked for zero rows — an
    // unconditional `.update({ status: "draft" }).eq("id", original.id)`
    // with no re-assertion of "posted" and no row-count check would let two
    // concurrent callers both "win" and both build a posted reversal mirror.
    const at = journalEntrySrc.indexOf('.update({ status: "draft" })');
    expect(at, "posted->draft update not found").toBeGreaterThan(-1);
    const chain = journalEntrySrc.slice(at, journalEntrySrc.indexOf(";", at));
    expect(chain).toMatch(/\.eq\("status",\s*"posted"\)/);
    expect(chain).toMatch(/\.select\("id"\)/);
    // ...and the caller must actually inspect that result for zero rows.
    const afterChain = journalEntrySrc.slice(journalEntrySrc.indexOf(";", at));
    expect(afterChain.slice(0, 300)).toMatch(/draftRows[\s\S]{0,60}length === 0/);
  });

  it("never discards the initial lookup's error", () => {
    const selectAt = journalEntrySrc.indexOf('.select("id")\n    .eq("source_kind"');
    expect(selectAt, "initial lookup not found").toBeGreaterThan(-1);
    const nearby = journalEntrySrc.slice(Math.max(0, selectAt - 120), selectAt + 400);
    expect(nearby).toMatch(/error:\s*lookupErr/);
    expect(nearby).toMatch(/if\s*\(lookupErr\)\s*return translatePgError\(lookupErr\)/);
  });

  it("treats a mismatched or missing entry as an error only when expectedEntryId is given", () => {
    expect(journalEntrySrc).toMatch(/expectedEntryId\?\s*:\s*string/);
    expect(journalEntrySrc).toMatch(/input\.expectedEntryId\s*&&\s*original\.id\s*!==\s*input\.expectedEntryId/);
  });
});

describe("markHistoricClaimsPaidAction / writeOffHistoricClaimsAction post the JE with a per-claim source_id", () => {
  // Undo predicates reverseJournalEntryBySource's lookup on
  // (source_kind='history_import', source_id=<claim id>) — a null source_id
  // would be ambiguous across every claim paid/written off in the same
  // batch (0037's partial unique index excludes null source_id rows, so this
  // is also why it's safe to give each claim its own id here).
  it("markHistoricClaimsPaidAction", () => {
    const body = bodyOf("markHistoricClaimsPaidAction");
    expect(body).toMatch(/source_kind:\s*"history_import" as never,\s*\n\s*(\/\/.*\n\s*)*source_id:\s*c\.id,/);
  });

  it("writeOffHistoricClaimsAction", () => {
    const body = bodyOf("writeOffHistoricClaimsAction");
    expect(body).toMatch(/source_kind:\s*"history_import" as never,\s*\n\s*(\/\/.*\n\s*)*source_id:\s*c\.id,/);
  });
});

// Browser check H2/H3 (2026-09-30): the summary audit row each bulk action
// writes (historic_hmo.marked_paid etc., resource_id = the first claim) was
// written AFTER the per-claim rows without a bulk_batch_id, so Undo's
// changed-since guard read it as someone else's later change and refused the
// first claim of every Mark paid / Write off batch.
describe("every historic bulk action's summary audit row carries its batch id", () => {
  it.each([
    ["markHistoricClaimsBilledAction", "historic_hmo.marked_billed"],
    ["markHistoricClaimsPaidAction", "historic_hmo.marked_paid"],
    ["writeOffHistoricClaimsAction", "historic_hmo.written_off"],
  ])("%s stamps bulk_batch_id on %s", (fnName, action) => {
    const body = bodyOf(fnName);
    const at = body.indexOf(`action: "${action}"`);
    expect(at, `${action} audit not found in ${fnName}`).toBeGreaterThan(-1);
    const auditCall = body.slice(at, body.indexOf("...meta", at));
    expect(auditCall).toMatch(/bulk_batch_id:\s*batchId/);
  });
});
