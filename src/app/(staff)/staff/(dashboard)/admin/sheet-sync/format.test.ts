// Pins the TypeScript vocabularies to migration 0170's inline CHECK lists,
// the same idea as website-messages-schema.test.ts for 0154. A kind added on
// one side only would either be offered in the review queue's kind chips and
// then rejected by the database, or be stored and render as "undefined".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewKind } from "@/lib/sheet-sync/types";
import { KIND_LABEL, STATUS_LABEL, TRIGGER_LABEL, TAB_LABEL, durationLabel } from "./format";

// Mirrors the ReviewKind union (types.ts has no runtime export for it) —
// this array IS the runtime source of truth the test checks both sides against.
const REVIEW_KINDS: ReviewKind[] = [
  "ambiguous_patient",
  "identity_conflict",
  "possible_existing_patient",
  "unmapped_source",
  "unparseable_date",
  "invalid_row",
  "suspect_snapshot",
];

const MIGRATION = readFileSync(
  join(__dirname, "../../../../../../../supabase/migrations/0170_sheet_sync_foundation.sql"),
  "utf8",
);

// 0170's inline `<column> text not null check (<column> in (...))` — unlike
// 0154's named `constraint ... check (...)`, these columns have no constraint
// name, so match on the column declaration itself. `[^)]*` spans the
// multi-line kind list fine (it excludes only the closing paren, not newlines).
function checkList(column: string, sql: string = MIGRATION): string[] {
  const re = new RegExp(
    `\\b${column}\\s+text\\s+not\\s+null(?:\\s+default\\s+'[^']*')?\\s+check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
    "i",
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`check list for column ${column} not found in 0170`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("0170 CHECK constraints match the TypeScript vocabularies", () => {
  it("sheet_sync_review_items.kind === ReviewKind", () => {
    expect(checkList("kind")).toEqual([...REVIEW_KINDS]);
  });

  it("every ReviewKind has a KIND_LABEL", () => {
    for (const k of REVIEW_KINDS) expect(KIND_LABEL[k]).toBeTruthy();
  });

  it("sheet_sync_runs.status has a STATUS_LABEL for every value", () => {
    for (const s of checkList("status")) expect(STATUS_LABEL[s]).toBeTruthy();
  });

  it("sheet_sync_runs.trigger has a TRIGGER_LABEL for every value", () => {
    for (const t of checkList("trigger")) expect(TRIGGER_LABEL[t]).toBeTruthy();
  });

  it("sheet_sync_review_items.tab has a TAB_LABEL for every value", () => {
    for (const t of checkList("tab")) expect(TAB_LABEL[t as keyof typeof TAB_LABEL]).toBeTruthy();
  });

  // Negative control: the parser really reads the list, so a drift is caught.
  it("detects a value missing from the TypeScript side", () => {
    expect(checkList("kind")).not.toEqual(REVIEW_KINDS.filter((k) => k !== "invalid_row"));
  });
});

describe("durationLabel", () => {
  it("formats sub-second durations in ms", () => {
    expect(durationLabel(250)).toBe("250 ms");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(durationLabel(4200)).toBe("4 s");
  });

  it("formats minute-plus durations as min + s", () => {
    expect(durationLabel(65000)).toBe("1 min 5 s");
  });

  it("shows an em dash for a missing duration", () => {
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(undefined)).toBe("—");
  });
});
