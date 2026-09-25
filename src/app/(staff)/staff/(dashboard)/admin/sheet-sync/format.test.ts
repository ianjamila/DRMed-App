// Pins the TypeScript vocabularies to migration 0170's inline CHECK lists,
// the same idea as website-messages-schema.test.ts for 0154. A kind added on
// one side only would either be offered in the review queue's kind chips and
// then rejected by the database, or be stored and render as "undefined".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewKind } from "@/lib/sheet-sync/types";
import type { RevertSummary } from "@/lib/sheet-sync/run";
import {
  KIND_LABEL,
  STATUS_LABEL,
  TRIGGER_LABEL,
  TAB_LABEL,
  RESOLUTION_ACTION_LABEL,
  DONE_KINDS,
  durationLabel,
  doneBannerMessage,
  isAutoResolution,
  isDoneKind,
  resolutionSummary,
  releaseSummaryLine,
  canRelease,
  isKeptUndoneActionable,
  revertSummaryLine,
  tabErrorLabel,
} from "./format";

// The runtime source of truth for the kind list (types.ts's ReviewKind is a
// type only, no runtime export) — KIND_LABEL's own keys, so every test below
// is really "does the migration's CHECK list match what this page labels".
const REVIEW_KINDS = Object.keys(KIND_LABEL) as ReviewKind[];

const MIGRATION = readFileSync(
  join(__dirname, "../../../../../../../supabase/migrations/0170_sheet_sync_foundation.sql"),
  "utf8",
);

// Scope a CHECK-list read to one `create table public.<table> (...)` block
// first, so a same-named column on an unrelated table earlier in the file
// (or added later) can never be the one the regex happens to match.
function tableBlock(table: string, sql: string = MIGRATION): string {
  const re = new RegExp(`create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const m = re.exec(sql);
  if (!m) throw new Error(`table public.${table} not found in 0170`);
  return m[1];
}

// 0170's inline `<column> text not null check (<column> in (...))` — unlike
// 0154's named `constraint ... check (...)`, these columns have no constraint
// name, so match on the column declaration itself. `[^)]*` spans the
// multi-line kind list fine (it excludes only the closing paren, not newlines).
function checkList(column: string, sql: string): string[] {
  const re = new RegExp(
    `\\b${column}\\s+text\\s+not\\s+null(?:\\s+default\\s+'[^']*')?\\s+check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
    "i",
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`check list for column ${column} not found`);
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  // A regex that silently matched nothing would make every "has a label for
  // every value" test above pass vacuously — fail loudly instead.
  if (items.length === 0) throw new Error(`check list for column ${column} parsed to an empty list — regex is broken`);
  return items;
}

const REVIEW_ITEMS_BLOCK = tableBlock("sheet_sync_review_items");
const RUNS_BLOCK = tableBlock("sheet_sync_runs");

describe("0170 CHECK constraints match the TypeScript vocabularies", () => {
  it("sheet_sync_review_items.kind === ReviewKind", () => {
    expect(checkList("kind", REVIEW_ITEMS_BLOCK)).toEqual([...REVIEW_KINDS]);
  });

  it("every ReviewKind has a KIND_LABEL", () => {
    for (const k of REVIEW_KINDS) expect(KIND_LABEL[k]).toBeTruthy();
  });

  it("sheet_sync_runs.status has a STATUS_LABEL for every value", () => {
    for (const s of checkList("status", RUNS_BLOCK)) expect(STATUS_LABEL[s]).toBeTruthy();
  });

  it("sheet_sync_runs.trigger has a TRIGGER_LABEL for every value", () => {
    for (const t of checkList("trigger", RUNS_BLOCK)) expect(TRIGGER_LABEL[t]).toBeTruthy();
  });

  it("sheet_sync_review_items.tab has a TAB_LABEL for every value", () => {
    for (const t of checkList("tab", REVIEW_ITEMS_BLOCK)) expect(TAB_LABEL[t as keyof typeof TAB_LABEL]).toBeTruthy();
  });

  // Negative control: the parser really reads the list, so a drift is caught.
  it("detects a value missing from the TypeScript side", () => {
    expect(checkList("kind", REVIEW_ITEMS_BLOCK)).not.toEqual(REVIEW_KINDS.filter((k) => k !== "invalid_row"));
  });

  it("tableBlock throws rather than matching nothing for an unknown table", () => {
    expect(() => tableBlock("no_such_table")).toThrow();
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

const ZERO_REVERT: RevertSummary = {
  restored: 0,
  blocked: 0,
  deleted: 0,
  kept: 0,
  held: 0,
  links_left: 0,
  alias_removed: 0,
  alias_restored: 0,
  gone: 0,
};

describe("revertSummaryLine", () => {
  it("always states the four core counts, even at zero", () => {
    expect(revertSummaryLine(ZERO_REVERT)).toBe(
      "Put back 0 · Kept 0 (changed since) · Removed 0 new patients · Kept 0 (in use)",
    );
  });

  it("appends gone, held and links_left only when nonzero, in plain words", () => {
    const line = revertSummaryLine({ ...ZERO_REVERT, restored: 3, gone: 2, held: 1, links_left: 4 });
    expect(line).toContain("Put back 3");
    expect(line).toContain("2 already removed by staff");
    expect(line).toContain("1 link(s) returned to review");
    expect(line).toContain("4 link(s) left as they were");
  });

  it("mentions the alias mapping outcome only when it changed", () => {
    expect(revertSummaryLine({ ...ZERO_REVERT, alias_restored: 1 })).toContain(
      'the previous "how did you hear" mapping was restored',
    );
    expect(revertSummaryLine({ ...ZERO_REVERT, alias_removed: 1 })).toContain("the answer mapping was removed");
    expect(revertSummaryLine(ZERO_REVERT)).not.toContain("mapping");
  });
});

describe("tabErrorLabel", () => {
  it("returns null for no error", () => {
    expect(tabErrorLabel("customers", null)).toBeNull();
    expect(tabErrorLabel("customers", undefined)).toBeNull();
  });

  it("rewords the suspect_snapshot machine prefix into plain words with the tab name", () => {
    const label = tabErrorLabel("customers", "suspect_snapshot: 1200 → 300 rows (−75%)");
    expect(label).not.toContain("suspect_snapshot:");
    expect(label).toContain(KIND_LABEL.suspect_snapshot);
    expect(label).toContain("Customers");
    expect(label).toContain("1200 rows last time");
    expect(label).toContain("300 now");
    expect(label).toContain("−75%");
  });

  it("passes through any other (already-safe) error text unchanged", () => {
    expect(tabErrorLabel("lab", "database error 08006")).toBe("database error 08006");
    expect(tabErrorLabel("lab", "This sheet sync lost its turn to another run.")).toBe(
      "This sheet sync lost its turn to another run.",
    );
  });
});

// Two of the four `resolution.action` values 0170 writes are literal
// jsonb_build_object('action', '<word>') calls (sheet_review_resolve's
// dismiss branch, sheet_alias_apply) — grepped straight from the migration
// text, the same "read the source of truth" idea as the CHECK-list tests
// above. The other two (link, create) are NOT literals there:
// sheet_review_resolve writes `jsonb_build_object('action', p_action, …)`
// with the p_action VARIABLE, so they're pinned instead via the guard a few
// lines above that constrains p_action to exactly this set once the dismiss
// branch has already returned — `if p_action is null or p_action not in
// ('link','create') or v_item.kind not in (…) then raise …`.
const RESOLUTION_ACTIONS_LITERAL = [...new Set(
  [...MIGRATION.matchAll(/jsonb_build_object\('action',\s*'([a-z]+)'/g)].map((m) => m[1]),
)];
const LINK_CREATE_GUARD_RE = /p_action is null or p_action not in \(([^)]*)\)/;
const linkCreateGuardMatch = LINK_CREATE_GUARD_RE.exec(MIGRATION);
if (!linkCreateGuardMatch) throw new Error("sheet_review_resolve's p_action guard not found — regex is broken");
const LINK_CREATE_ACTIONS = [...linkCreateGuardMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
const RESOLUTION_ACTIONS = [...new Set([...RESOLUTION_ACTIONS_LITERAL, ...LINK_CREATE_ACTIONS])];

describe("RESOLUTION_ACTION_LABEL", () => {
  it("found the alias/dismiss literals and the link/create guard list (regexes aren't broken)", () => {
    expect(RESOLUTION_ACTIONS_LITERAL.length).toBeGreaterThan(0);
    expect(LINK_CREATE_ACTIONS).toEqual(["link", "create"]);
  });

  it("has a label for every resolution action 0170 can write — all five: link, create, dismiss, alias, released", () => {
    expect([...RESOLUTION_ACTIONS].sort()).toEqual(["alias", "create", "dismiss", "link", "released"]);
    for (const a of RESOLUTION_ACTIONS) expect(RESOLUTION_ACTION_LABEL[a]).toBeTruthy();
  });
});

describe("resolutionSummary", () => {
  it("shows an em dash for no resolution yet", () => {
    expect(resolutionSummary(null)).toBe("—");
    expect(resolutionSummary(undefined)).toBe("—");
  });

  it("labels link and create plainly", () => {
    expect(resolutionSummary({ action: "link", patient_id: "p1" })).toBe("Linked to a patient");
    expect(resolutionSummary({ action: "create" })).toBe("Created a new patient");
  });

  it("a plain dismiss reads Dismissed", () => {
    expect(resolutionSummary({ action: "dismiss", keep_undone: false })).toBe("Dismissed");
  });

  it("a dismiss with keep_undone reads Kept undone, not Dismissed", () => {
    expect(resolutionSummary({ action: "dismiss", keep_undone: true })).toBe("Kept undone");
  });

  it("an item the sync raised already kept undone after an undo says so", () => {
    expect(resolutionSummary({ action: "dismiss", keep_undone: true, auto_from_undo: true, candidate_ids: [] }))
      .toBe("Kept undone (by the undo)");
  });

  it("a released item reads as handed back to the sync", () => {
    expect(resolutionSummary({ action: "released", undo_run_id: "u", release_run_id: "r" })).toBe("Released — the sync decides again");
  });

  it("names the channel an alias was mapped to", () => {
    expect(resolutionSummary({ action: "alias", referral_source_id: "family_friends" })).toBe(
      "Mapped to Family / friends",
    );
  });

  it("falls back to the bare action word for an unknown referral_source_id", () => {
    expect(resolutionSummary({ action: "alias", referral_source_id: "not_a_real_id" })).toBe(
      RESOLUTION_ACTION_LABEL.alias,
    );
  });

  it("reads an automatic clear (0170's sheet_sync_upsert_review, p_clear_absent) as Cleared, not an em dash", () => {
    expect(resolutionSummary({ auto: "no longer reported by the sheet" })).toBe("Cleared — no longer in the sheet");
  });

  it("never echoes the raw resolution.auto text onto the screen", () => {
    expect(resolutionSummary({ auto: "some future internal marker text" })).not.toContain(
      "some future internal marker text",
    );
  });
});

// 0170's sheet_sync_upsert_review writes exactly this shape for an
// auto-clear: `jsonb_build_object('auto', 'no longer reported by the
// sheet')` — pinned so `isAutoResolution` and `resolutionSummary` can't
// silently drift from what the migration actually writes.
describe("isAutoResolution", () => {
  it("matches the migration's own auto-clear literal", () => {
    expect(MIGRATION).toContain("jsonb_build_object('auto', 'no longer reported by the sheet')");
  });

  it("is true only when resolution.auto is a string", () => {
    expect(isAutoResolution({ auto: "no longer reported by the sheet" })).toBe(true);
    expect(isAutoResolution({ action: "dismiss", keep_undone: false })).toBe(false);
    expect(isAutoResolution(null)).toBe(false);
    expect(isAutoResolution(undefined)).toBe(false);
    expect(isAutoResolution({ auto: 123 })).toBe(false);
  });
});

describe("isDoneKind / doneBannerMessage (the ?done=&n= success banner)", () => {
  it("accepts only the known done kinds", () => {
    for (const k of DONE_KINDS) expect(isDoneKind(k)).toBe(true);
    expect(isDoneKind("revert")).toBe(false);
    expect(isDoneKind(undefined)).toBe(false);
    expect(isDoneKind("")).toBe(false);
  });

  it("states the count and says the change is undoable", () => {
    expect(doneBannerMessage("alias", 12)).toBe(
      "Answer mapped — 12 patients updated. You can undo it from Run history.",
    );
    expect(doneBannerMessage("resort", 1)).toBe(
      "Group approved — 1 patient updated. You can undo it from Run history.",
    );
  });

  it("pluralises on zero too", () => {
    expect(doneBannerMessage("alias", 0)).toContain("0 patients updated");
  });
});

describe("releaseSummaryLine", () => {
  it("counts the rows handed back and the review items closed", () => {
    expect(releaseSummaryLine({ released: 4521, items_resolved: 4509 })).toBe("4521 rows handed back to the sync · 4509 review items closed");
    expect(releaseSummaryLine({ released: 1, items_resolved: 0 })).toBe("1 row handed back to the sync");
  });
});

describe("canRelease — Let the sync decide again", () => {
  const undo = (over: Partial<Parameters<typeof canRelease>[0]> = {}) =>
    ({ trigger: "revert", status: "succeeded", released_by_run_id: null, summary: { result: { held: 4521 } }, ...over });
  it("offers it on a finished undo that held rows back", () => {
    expect(canRelease(undo())).toBe(true);
  });
  it("not on an undo that held nothing, is still running, was already released, or has no result", () => {
    expect(canRelease(undo({ summary: { result: { held: 0 } } }))).toBe(false);
    expect(canRelease(undo({ status: "running" }))).toBe(false);
    expect(canRelease(undo({ released_by_run_id: "r" }))).toBe(false);
    expect(canRelease(undo({ summary: null }))).toBe(false);
  });
  it("never on a run that is not an undo", () => {
    for (const trigger of ["cron", "manual", "cli", "resort", "alias", "release"]) expect(canRelease(undo({ trigger }))).toBe(false);
  });
});

describe("isKeptUndoneActionable — Link / Create on a handled kept-undone row", () => {
  const item = (over: Partial<Parameters<typeof isKeptUndoneActionable>[0]> = {}) =>
    ({ kind: "ambiguous_patient", status: "dismissed", resolution: { action: "dismiss", keep_undone: true }, ...over });
  it("yes for an identity item kept undone — by an admin or raised that way after an undo", () => {
    expect(isKeptUndoneActionable(item())).toBe(true);
    expect(isKeptUndoneActionable(item({ kind: "identity_conflict", resolution: { action: "dismiss", keep_undone: true, auto_from_undo: true } }))).toBe(true);
    expect(isKeptUndoneActionable(item({ kind: "possible_existing_patient" }))).toBe(true);
  });
  it("no for a plain dismissal, a resolved / released item, or a non-identity kind", () => {
    expect(isKeptUndoneActionable(item({ resolution: { action: "dismiss", keep_undone: false } }))).toBe(false);
    expect(isKeptUndoneActionable(item({ status: "resolved", resolution: { action: "released" } }))).toBe(false);
    expect(isKeptUndoneActionable(item({ kind: "unparseable_date" }))).toBe(false);
    expect(isKeptUndoneActionable(item({ resolution: null }))).toBe(false);
  });
});
