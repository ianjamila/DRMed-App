# Bulk row selection — PR 1 (shared kit + Appointments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reception/admin tick several bookings on `/staff/appointments` and run Mark arrived / No-show / Cancel / Confirm / Revert / Delete on all of them from one sticky bar, using a shared row-selection kit the queue and inbox PRs will reuse.

**Architecture:** A pure selection reducer (`src/lib/ui/bulk-selection.ts`) enforces two caps (100 rows, 500 records) and never splits a row. A client `SelectionProvider` (keyed by the page's list params so the selection drops when the list changes) wraps the server-rendered tables; each row renders a checkbox island; a sticky `BulkBar` renders page-specific actions. Appointments adds two server actions that take a batch of bookings as `{ ids, from }` (the status the operator saw), write one UPDATE/DELETE per expected status with `eq("status", from)` so a stale click never overwrites a colleague's change, keep the all-or-nothing active-patient guard, audit one row per appointment from the rows the write returned (sibling ids derived server-side from `booking_group_id`), and return `changedIds` so the bar can report partial results per booking.

**Tech Stack:** Next.js 16 App Router (RSC + Server Actions), React 19, Supabase JS, zod, vitest (Node, no DOM), Tailwind, the repo's `Button`/`Panel` primitives.

**Spec:** `docs/superpowers/specs/2026-09-25-bulk-row-selection-design.md` (§4, §5, §8, §9).

**Worktree:** `~/Claude/DRMed/.worktrees/bulk-select`, branch `feat/bulk-select`. Run every command from there. No migration. Read `CLAUDE.md` and `.claude/skills/drmed-staff-ui/SKILL.md` §4 first.

**Conventions that bite here:** Server Actions may only export async functions (constants go in `src/lib`). `*.test.ts` runs in Node — no DOM, no effects; test pure modules. `src/lib/patients/write-guards.test.ts` scans every function that writes `appointments` and fails unless it calls a `assert*Active` guard or is listed in `EXEMPT` with a reason. Buttons are sentence case. Never `git stash`.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/ui/bulk-selection.ts` (new) | Pure selection state + caps: `addEntries`, `removeKeys`, `toggleEntry`, `keysByKind`, `selectAllState`, `canAdd`, `recordsOf` |
| `src/lib/ui/bulk-selection.test.ts` (new) | Unit tests for the above |
| `src/components/staff/row-selection/selection-context.tsx` (new) | `SelectionProvider` (`resetKey`), `useRowSelection` |
| `src/components/staff/row-selection/row-select-checkbox.tsx` (new) | Per-row checkbox island |
| `src/components/staff/row-selection/select-all-checkbox.tsx` (new) | Header checkbox with indeterminate state |
| `src/components/staff/row-selection/bulk-bar.tsx` (new) | Sticky bar shell, count, Clear, Escape |
| `src/lib/appointments/bulk-eligibility.ts` (new) | `bulkActionPlan`, `summariseOutcome`, `outcomeMessage`, `BULK_TARGET` |
| `src/lib/appointments/bulk-eligibility.test.ts` (new) | Unit tests |
| `src/app/(staff)/staff/(dashboard)/appointments/actions.ts` (modify) | `ApptResult.changedIds`, `transitionGroups` / `deleteGroups` over `{ ids, from }` batches (per-status predicate, server-derived siblings, audit from returned rows), `bulkTransitionAction`, `bulkDeleteAction`, cap |
| `src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx` (new) | The page's bar: buttons, confirms, outcome messages |
| `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` (modify) | Provider + resetKey, checkbox column in `Section`/`FlatTable`/`GroupRow`, `groupsByKey`, bar |
| `src/lib/patients/write-guards.test.ts` (modify) | `EXEMPT` entry for `deleteGroups` |
| `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-booking-and-intake/SKILL.md` (modify) | Guide v2.27 + skill pointers |

---

### Task 1: Pure selection reducer

**Files:**
- Create: `src/lib/ui/bulk-selection.ts`
- Test: `src/lib/ui/bulk-selection.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/ui/bulk-selection.test.ts
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  addEntries,
  canAdd,
  keysByKind,
  recordsOf,
  removeKeys,
  selectAllState,
  toggleEntry,
  type SelectionEntry,
} from "./bulk-selection";

const e = (rowKey: string, kinds: string[] = ["confirmed"], weight = 1): SelectionEntry => ({
  rowKey,
  kinds,
  weight,
});
const limits = { rows: 3, records: 5 };

describe("addEntries", () => {
  it("adds in order and reports nothing refused under the caps", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a"), e("b")], limits);
    expect([...next.keys()]).toEqual(["a", "b"]);
    expect(refused).toEqual([]);
  });

  it("stops at the row cap and refuses everything from that entry on", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c"), e("d"), e("e")], limits);
    expect([...next.keys()]).toEqual(["a", "b", "c"]);
    expect(refused).toEqual(["d", "e"]);
  });

  it("stops at the record cap without splitting a heavy row", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a", ["x"], 2), e("b", ["x"], 3), e("c", ["x"], 1)], limits);
    // a(2) + b(3) = 5 fits; c(1) would make 6 → refused, and a/b stay whole.
    expect([...next.keys()]).toEqual(["a", "b"]);
    expect(refused).toEqual(["c"]);
    expect(recordsOf(next)).toBe(5);
  });

  it("skips keys already selected and returns the same reference when nothing changes", () => {
    const { next: first } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    const { next: again, refused } = addEntries(first, [e("a")], limits);
    expect(again).toBe(first);
    expect(refused).toEqual([]);
  });
});

describe("removeKeys / toggleEntry", () => {
  it("removes only the given keys and keeps the rest", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c")], limits);
    const after = removeKeys(next, ["b", "zzz"]);
    expect([...after.keys()]).toEqual(["a", "c"]);
  });

  it("returns the same reference when no key was present", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    expect(removeKeys(next, ["nope"])).toBe(next);
  });

  it("toggle adds when absent and removes when present", () => {
    const on = toggleEntry(EMPTY_SELECTION, e("a"), limits);
    expect(on.has("a")).toBe(true);
    const off = toggleEntry(on, e("a"), limits);
    expect(off.has("a")).toBe(false);
  });

  it("toggle is a no-op past the cap", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c")], limits);
    expect(toggleEntry(next, e("d"), limits)).toBe(next);
    expect(canAdd(next, e("d"), limits)).toBe(false);
    expect(canAdd(next, e("a"), limits)).toBe(true); // already in — always allowed
  });
});

describe("keysByKind / selectAllState", () => {
  it("groups keys under every kind they carry", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a", ["claimable"]), e("b", ["unclaimable", "deletable"])], limits);
    expect(keysByKind(next)).toEqual({ claimable: ["a"], unclaimable: ["b"], deletable: ["b"] });
  });

  it("reports none / some / all for a table's entries", () => {
    const entries = [e("a"), e("b")];
    expect(selectAllState(entries, EMPTY_SELECTION)).toBe("none");
    const { next: one } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    expect(selectAllState(entries, one)).toBe("some");
    const { next: both } = addEntries(one, [e("b")], limits);
    expect(selectAllState(entries, both)).toBe("all");
    expect(selectAllState([], both)).toBe("none");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ui/bulk-selection.test.ts`
Expected: FAIL — cannot resolve `./bulk-selection`.

- [ ] **Step 3: Implement**

```ts
// src/lib/ui/bulk-selection.ts
// Pure state for the shared row-selection kit (src/components/staff/row-selection).
// Lives in src/lib so both the client provider and the server actions' caps can
// import it — "use server" modules may only export async functions, and
// vitest can test this without a DOM.

/** Selected rows per action (bookings / tests / messages). */
export const MAX_BULK_ROWS = 100;
/** Deduplicated underlying record ids per action (a booking with 6 services is 6). */
export const MAX_BULK_RECORDS = 500;

export interface SelectionLimits {
  rows: number;
  records: number;
}

export const DEFAULT_LIMITS: SelectionLimits = {
  rows: MAX_BULK_ROWS,
  records: MAX_BULK_RECORDS,
};

export interface SelectionEntry {
  /** Opaque row identity — a booking-group key, a test_request id, a message id. */
  rowKey: string;
  /** What the bar may do with this row; a row can carry several. */
  kinds: readonly string[];
  /** How many underlying records the row expands to (≥ 1). */
  weight: number;
}

export type SelectionState = ReadonlyMap<string, SelectionEntry>;

export const EMPTY_SELECTION: SelectionState = new Map();

export function recordsOf(state: SelectionState): number {
  let total = 0;
  for (const entry of state.values()) total += entry.weight;
  return total;
}

/** True when the entry is already selected, or adding it stays under both caps. */
export function canAdd(
  state: SelectionState,
  entry: SelectionEntry,
  limits: SelectionLimits = DEFAULT_LIMITS,
): boolean {
  if (state.has(entry.rowKey)) return true;
  return state.size + 1 <= limits.rows && recordsOf(state) + entry.weight <= limits.records;
}

/**
 * Adds entries in order. Stops before the first entry that would exceed either
 * cap and reports it and everything after it as refused — a row is never
 * split. Returns the same Map reference when nothing was added so React can
 * bail out of a re-render.
 */
export function addEntries(
  state: SelectionState,
  entries: readonly SelectionEntry[],
  limits: SelectionLimits = DEFAULT_LIMITS,
): { next: SelectionState; refused: string[] } {
  let next: Map<string, SelectionEntry> | null = null;
  let rows = state.size;
  let records = recordsOf(state);
  const refused: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if ((next ?? state).has(entry.rowKey)) continue;
    if (rows + 1 > limits.rows || records + entry.weight > limits.records) {
      for (let j = i; j < entries.length; j++) {
        const rest = entries[j]!;
        if (!(next ?? state).has(rest.rowKey)) refused.push(rest.rowKey);
      }
      break;
    }
    next ??= new Map(state);
    next.set(entry.rowKey, entry);
    rows += 1;
    records += entry.weight;
  }
  return { next: next ?? state, refused };
}

/** Removes the given keys; same reference when none was present. */
export function removeKeys(state: SelectionState, keys: readonly string[]): SelectionState {
  let next: Map<string, SelectionEntry> | null = null;
  for (const key of keys) {
    if (!(next ?? state).has(key)) continue;
    next ??= new Map(state);
    next.delete(key);
  }
  return next ?? state;
}

export function toggleEntry(
  state: SelectionState,
  entry: SelectionEntry,
  limits: SelectionLimits = DEFAULT_LIMITS,
): SelectionState {
  if (state.has(entry.rowKey)) return removeKeys(state, [entry.rowKey]);
  return addEntries(state, [entry], limits).next;
}

/** Every selected key under every kind it carries, in selection order. */
export function keysByKind(state: SelectionState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of state.values()) {
    for (const kind of entry.kinds) (out[kind] ??= []).push(entry.rowKey);
  }
  return out;
}

export type SelectAllState = "none" | "some" | "all";

/** For a header checkbox over the rows one table renders on this page. */
export function selectAllState(
  entries: readonly SelectionEntry[],
  state: SelectionState,
): SelectAllState {
  if (entries.length === 0) return "none";
  let selected = 0;
  for (const entry of entries) if (state.has(entry.rowKey)) selected += 1;
  if (selected === 0) return "none";
  return selected === entries.length ? "all" : "some";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ui/bulk-selection.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/bulk-selection.ts src/lib/ui/bulk-selection.test.ts
git commit -m "feat(ui): pure row-selection state with row and record caps"
```

---

### Task 2: SelectionProvider + useRowSelection

**Files:**
- Create: `src/components/staff/row-selection/selection-context.tsx`

No unit test (hooks + context need a DOM; the reducer it wraps is tested in Task 1; browser acceptance in Task 9).

- [ ] **Step 1: Write the provider**

```tsx
// src/components/staff/row-selection/selection-context.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LIMITS,
  EMPTY_SELECTION,
  addEntries,
  canAdd as canAddPure,
  keysByKind as keysByKindPure,
  recordsOf,
  removeKeys,
  toggleEntry,
  type SelectionEntry,
  type SelectionLimits,
  type SelectionState,
} from "@/lib/ui/bulk-selection";

export interface RowSelection {
  state: SelectionState;
  isSelected: (rowKey: string) => boolean;
  toggle: (entry: SelectionEntry) => void;
  /** Header select-all: adds (stopping at the caps) or removes the given entries. */
  setMany: (entries: readonly SelectionEntry[], selected: boolean) => void;
  clear: () => void;
  /** Prune after a successful action, or when a row's checkbox unmounts / changes kind. */
  clearKeys: (rowKeys: readonly string[]) => void;
  canAdd: (entry: SelectionEntry) => boolean;
  keysByKind: Record<string, string[]>;
  count: number;
  records: number;
  /** How many rows the last setMany could not add because a cap was reached; 0 after any other change. */
  refusedCount: number;
  limits: SelectionLimits;
}

const SelectionContext = createContext<RowSelection | null>(null);

interface ProviderProps {
  /**
   * A normalised string of every list parameter that changes the row set or
   * its order (view, filters, sort, page, size, search…). It is applied as the
   * React key of the inner provider, so the selection drops whenever the list
   * changes. Search-param navigation does NOT remount client components by
   * itself — this key is the mechanism.
   */
  resetKey: string;
  limits?: SelectionLimits;
  children: ReactNode;
}

export function SelectionProvider({ resetKey, limits, children }: ProviderProps) {
  return (
    <InnerProvider key={resetKey} limits={limits ?? DEFAULT_LIMITS}>
      {children}
    </InnerProvider>
  );
}

function InnerProvider({ limits, children }: { limits: SelectionLimits; children: ReactNode }) {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const [refusedCount, setRefusedCount] = useState(0);

  const toggle = useCallback(
    (entry: SelectionEntry) => {
      setRefusedCount(0);
      setState((prev) => toggleEntry(prev, entry, limits));
    },
    [limits],
  );

  const setMany = useCallback(
    (entries: readonly SelectionEntry[], selected: boolean) => {
      if (!selected) {
        setRefusedCount(0);
        setState((prev) => removeKeys(prev, entries.map((e) => e.rowKey)));
        return;
      }
      setState((prev) => {
        const { next, refused } = addEntries(prev, entries, limits);
        setRefusedCount(refused.length);
        return next;
      });
    },
    [limits],
  );

  const clear = useCallback(() => {
    setRefusedCount(0);
    setState(EMPTY_SELECTION);
  }, []);

  const clearKeys = useCallback((rowKeys: readonly string[]) => {
    if (rowKeys.length === 0) return;
    // removeKeys returns the same reference when nothing was removed, so the
    // unmount-pruning effect (fires for every row on a full revalidation) does
    // not cause a re-render.
    setState((prev) => removeKeys(prev, rowKeys));
  }, []);

  const isSelected = useCallback((rowKey: string) => state.has(rowKey), [state]);
  const canAdd = useCallback(
    (entry: SelectionEntry) => canAddPure(state, entry, limits),
    [state, limits],
  );
  const byKind = useMemo(() => keysByKindPure(state), [state]);

  const value = useMemo<RowSelection>(
    () => ({
      state,
      isSelected,
      toggle,
      setMany,
      clear,
      clearKeys,
      canAdd,
      keysByKind: byKind,
      count: state.size,
      records: recordsOf(state),
      refusedCount,
      limits,
    }),
    [state, isSelected, toggle, setMany, clear, clearKeys, canAdd, byKind, refusedCount, limits],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useRowSelection(): RowSelection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useRowSelection must be used within a SelectionProvider");
  return ctx;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/staff/row-selection/selection-context.tsx
git commit -m "feat(staff): shared SelectionProvider keyed by list params"
```

---

### Task 3: RowSelectCheckbox, SelectAllCheckbox, BulkBar

**Files:**
- Create: `src/components/staff/row-selection/row-select-checkbox.tsx`
- Create: `src/components/staff/row-selection/select-all-checkbox.tsx`
- Create: `src/components/staff/row-selection/bulk-bar.tsx`

- [ ] **Step 1: Row checkbox**

```tsx
// src/components/staff/row-selection/row-select-checkbox.tsx
"use client";

import { useEffect, useMemo } from "react";
import { useRowSelection } from "./selection-context";

interface Props {
  rowKey: string;
  kinds: readonly string[];
  /** Underlying records this row expands to (a booking's services). Default 1. */
  weight?: number;
  /** Feeds the aria-label, e.g. "Select Maria Santos, 3 services". */
  label: string;
}

// Leading checkbox cell for a selectable row. Disables itself when adding the
// row would pass either cap. Prunes its key when it unmounts OR when its
// kinds/weight change after a refresh — the same eligibility rule as the visit
// page's checkbox — so a row that changed under the operator is never acted
// on under its old kinds.
export function RowSelectCheckbox({ rowKey, kinds, weight = 1, label }: Props) {
  const { isSelected, toggle, clearKeys, canAdd, limits } = useRowSelection();
  const kindsKey = kinds.join("|");
  const entry = useMemo(
    () => ({ rowKey, kinds: kindsKey.split("|").filter(Boolean), weight }),
    [rowKey, kindsKey, weight],
  );

  useEffect(() => {
    return () => clearKeys([rowKey]);
  }, [rowKey, kindsKey, weight, clearKeys]);

  const checked = isSelected(rowKey);
  const blocked = !checked && !canAdd(entry);

  return (
    <label className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={blocked}
        onChange={() => toggle(entry)}
        aria-label={`Select ${label}`}
        title={blocked ? `You can select up to ${limits.rows} rows at a time` : undefined}
        className="h-4 w-4 accent-[color:var(--color-brand-cyan)] disabled:opacity-40"
      />
    </label>
  );
}
```

- [ ] **Step 2: Header select-all**

```tsx
// src/components/staff/row-selection/select-all-checkbox.tsx
"use client";

import { useEffect, useRef } from "react";
import { selectAllState, type SelectionEntry } from "@/lib/ui/bulk-selection";
import { useRowSelection } from "./selection-context";

interface Props {
  /** The selectable rows THIS table renders on this page — serialisable, built by the server page. */
  entries: readonly SelectionEntry[];
  label: string;
}

// Header checkbox over one table. Checked when every entry is selected,
// indeterminate when some are; clicking at "all" removes them, otherwise adds
// the rest (setMany stops at the caps and the bar says so).
export function SelectAllCheckbox({ entries, label }: Props) {
  const { state, setMany } = useRowSelection();
  const status = selectAllState(entries, state);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = status === "some";
  }, [status]);

  return (
    <label className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={status === "all"}
        disabled={entries.length === 0}
        onChange={() => setMany(entries, status !== "all")}
        aria-label={label}
        className="h-4 w-4 accent-[color:var(--color-brand-cyan)] disabled:opacity-40"
      />
    </label>
  );
}
```

- [ ] **Step 3: Bar shell**

```tsx
// src/components/staff/row-selection/bulk-bar.tsx
"use client";

import { useEffect, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { useRowSelection } from "./selection-context";

interface Props {
  /** Singular noun for the count: "booking", "test", "message". */
  noun: string;
  children: ReactNode;
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
}

// Sticky bottom toolbar (visit-page / HMO-claims styling). Rendered as the
// LAST child inside the SelectionProvider so it stays in-flow and sticks to
// the viewport bottom while the tables are in view. Escape clears the
// selection unless a dialog/sheet is open or focus is in a text field.
export function BulkBar({ noun, children }: Props) {
  const { count, clear, refusedCount, limits } = useRowSelection();

  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isTextTarget(event.target)) return;
      clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, clear]);

  if (count === 0) return null;

  return (
    <Panel
      role="region"
      aria-label="Selected rows"
      className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-3 p-3 shadow-sm"
    >
      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">{count}</span>{" "}
        {noun}
        {count === 1 ? "" : "s"} selected ·{" "}
        <button type="button" onClick={clear} className="font-semibold hover:underline">
          Clear
        </button>
        {refusedCount > 0 ? (
          <span className="ml-2 text-amber-700">
            Selected the first {count} — the limit is {limits.rows} rows at a time
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </Panel>
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -5`
Expected: clean. If `react-hooks/exhaustive-deps` warns about `kinds` in `row-select-checkbox.tsx`, keep the `kindsKey` form (the prop array identity changes every render; the joined string is the stable identity) and add the one-line disable comment above the `useMemo` explaining that.

- [ ] **Step 5: Commit**

```bash
git add src/components/staff/row-selection/
git commit -m "feat(staff): row-selection checkbox, select-all and bulk bar components"
```

---

### Task 4: Appointment bulk eligibility (pure)

**Files:**
- Create: `src/lib/appointments/bulk-eligibility.ts`
- Test: `src/lib/appointments/bulk-eligibility.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/appointments/bulk-eligibility.test.ts
import { describe, expect, it } from "vitest";
import {
  BULK_TARGET,
  bulkActionPlan,
  outcomeMessage,
  summariseOutcome,
  type BulkGroup,
} from "./bulk-eligibility";

const g = (key: string, status: string, patientActive = true): BulkGroup => ({ key, status, patientActive });

describe("bulkActionPlan", () => {
  const groups = [
    g("c1", "confirmed"),
    g("c2", "confirmed", false),
    g("a1", "arrived"),
    g("n1", "no_show"),
    g("x1", "cancelled"),
    g("p1", "pending_callback"),
    g("p2", "pending_callback", false),
    g("d1", "completed"),
  ];

  it("maps every status to the buttons ALLOWED_FROM permits", () => {
    const plan = bulkActionPlan(groups, true);
    expect(plan.arrive.keys).toEqual(["c1"]);
    expect(plan.noShow.keys).toEqual(["c1", "c2"]);
    expect(plan.cancel.keys).toEqual(["c1", "c2", "a1", "p1", "p2"]);
    expect(plan.confirm.keys).toEqual(["p1"]);
    expect(plan.revert.keys).toEqual(["a1", "n1", "x1"]);
    expect(plan.delete.keys).toEqual(["c1", "c2", "a1", "n1", "x1", "p1", "p2"]);
  });

  it("counts inactive-patient rows it skipped for arrive/confirm/revert only", () => {
    const plan = bulkActionPlan(groups, true);
    expect(plan.arrive.skippedInactive).toBe(1);
    expect(plan.confirm.skippedInactive).toBe(1);
    expect(plan.revert.skippedInactive).toBe(0);
    expect(plan.cancel.skippedInactive).toBe(0);
    expect(plan.noShow.skippedInactive).toBe(0);
  });

  it("never offers delete to non-admins and never touches completed", () => {
    const plan = bulkActionPlan(groups, false);
    expect(plan.delete.keys).toEqual([]);
    for (const entry of Object.values(plan)) expect(entry.keys).not.toContain("d1");
  });

  it("targets the server transition each button means", () => {
    expect(BULK_TARGET).toEqual({
      arrive: "arrived",
      noShow: "no_show",
      cancel: "cancelled",
      confirm: "confirmed",
      revert: "confirmed",
    });
  });
});

describe("summariseOutcome / outcomeMessage", () => {
  const groupsByKey = {
    a: { ids: ["a1", "a2"], status: "confirmed", patientActive: true },
    b: { ids: ["b1"], status: "confirmed", patientActive: true },
    c: { ids: ["c1", "c2"], status: "confirmed", patientActive: true },
  };

  it("classifies each sent booking as changed, partly changed or unchanged", () => {
    const s = summariseOutcome(["a", "b", "c"], groupsByKey, ["a1", "a2", "c1"]);
    expect(s).toEqual({ changed: ["a"], partly: ["c"], unchanged: ["b"] });
  });

  it("says nothing extra when everything changed", () => {
    expect(outcomeMessage("Marked", "arrived", { changed: ["a", "b"], partly: [], unchanged: [] })).toBeNull();
  });

  it("explains partial results in bookings", () => {
    expect(
      outcomeMessage("Marked", "arrived", { changed: ["a"], partly: ["c"], unchanged: ["b"] }),
    ).toBe(
      "Marked 1 of 3 bookings arrived. 1 partly changed — open it to check. 1 had already changed.",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/appointments/bulk-eligibility.test.ts`
Expected: FAIL — cannot resolve `./bulk-eligibility`.

- [ ] **Step 3: Implement**

```ts
// src/lib/appointments/bulk-eligibility.ts
// Which bulk buttons the appointments bar offers for a selection, and how a
// server result maps back to bookings. Pure — the server actions still apply
// ALLOWED_FROM and the active-patient guard themselves; this only decides
// what to send and how to word the outcome.

export type BulkAction = "arrive" | "noShow" | "cancel" | "confirm" | "revert" | "delete";

/** Mirrors ALLOWED_FROM in appointments/actions.ts (keyed by button, not target). */
export const BULK_ELIGIBLE_FROM: Record<BulkAction, readonly string[]> = {
  arrive: ["confirmed"],
  noShow: ["confirmed"],
  cancel: ["confirmed", "arrived", "pending_callback"],
  confirm: ["pending_callback"],
  revert: ["arrived", "no_show", "cancelled"],
  delete: ["confirmed", "arrived", "no_show", "cancelled", "pending_callback"],
};

/** Statuses the bulk delete may remove — the server enforces this list in the write. */
export const BULK_DELETABLE_STATUSES = BULK_ELIGIBLE_FROM.delete;

/** The server transition each non-delete button fires. */
export const BULK_TARGET: Record<Exclude<BulkAction, "delete">, "arrived" | "no_show" | "cancelled" | "confirmed"> = {
  arrive: "arrived",
  noShow: "no_show",
  cancel: "cancelled",
  confirm: "confirmed",
  revert: "confirmed",
};

/** Buttons that put work back on a patient record and therefore need an active patient. */
const NEEDS_ACTIVE_PATIENT: ReadonlySet<BulkAction> = new Set(["arrive", "confirm", "revert"]);

export interface BulkGroup {
  key: string;
  status: string;
  patientActive: boolean;
}

export interface BulkPlanEntry {
  keys: string[];
  skippedInactive: number;
}

export function bulkActionPlan(
  groups: readonly BulkGroup[],
  isAdmin: boolean,
): Record<BulkAction, BulkPlanEntry> {
  const plan = {} as Record<BulkAction, BulkPlanEntry>;
  for (const action of Object.keys(BULK_ELIGIBLE_FROM) as BulkAction[]) {
    const entry: BulkPlanEntry = { keys: [], skippedInactive: 0 };
    if (action === "delete" && !isAdmin) {
      plan[action] = entry;
      continue;
    }
    const from = BULK_ELIGIBLE_FROM[action];
    for (const group of groups) {
      if (!from.includes(group.status)) continue;
      if (NEEDS_ACTIVE_PATIENT.has(action) && !group.patientActive) {
        entry.skippedInactive += 1;
        continue;
      }
      entry.keys.push(group.key);
    }
    plan[action] = entry;
  }
  return plan;
}

export interface GroupInfo {
  ids: string[];
  status: string;
  patientActive: boolean;
}

export interface Outcome {
  changed: string[];
  partly: string[];
  unchanged: string[];
}

/** Maps the ids a write returned back to the bookings that were sent. */
export function summariseOutcome(
  sentKeys: readonly string[],
  groupsByKey: Record<string, GroupInfo>,
  changedIds: readonly string[],
): Outcome {
  const changedSet = new Set(changedIds);
  const out: Outcome = { changed: [], partly: [], unchanged: [] };
  for (const key of sentKeys) {
    const ids = groupsByKey[key]?.ids ?? [];
    const hits = ids.filter((id) => changedSet.has(id)).length;
    if (ids.length > 0 && hits === ids.length) out.changed.push(key);
    else if (hits > 0) out.partly.push(key);
    else out.unchanged.push(key);
  }
  return out;
}

/** null when every booking changed; otherwise the alert text. */
export function outcomeMessage(verb: string, pastTense: string, outcome: Outcome): string | null {
  const total = outcome.changed.length + outcome.partly.length + outcome.unchanged.length;
  if (outcome.partly.length === 0 && outcome.unchanged.length === 0) return null;
  const parts = [`${verb} ${outcome.changed.length} of ${total} bookings ${pastTense}.`];
  if (outcome.partly.length > 0) {
    parts.push(
      `${outcome.partly.length} partly changed — open ${outcome.partly.length === 1 ? "it" : "them"} to check.`,
    );
  }
  if (outcome.unchanged.length > 0) parts.push(`${outcome.unchanged.length} had already changed.`);
  return parts.join(" ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/appointments/bulk-eligibility.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/appointments/bulk-eligibility.ts src/lib/appointments/bulk-eligibility.test.ts
git commit -m "feat(appointments): pure bulk-action plan and outcome summary"
```

---

### Task 5: Server actions — groups, changedIds, returned-row audit, caps

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/actions.ts` (`ApptResult` ~line 36, `transitionGroup` 38–105, `deleteAppointmentAction` 424–475)
- Modify: `src/lib/patients/write-guards.test.ts` (`EXEMPT`, near line 134)

- [ ] **Step 1: Change the result type and generalise `transitionGroup` to a batch with expected statuses**

Replace the `ApptResult` type and the whole `transitionGroup` function with:

```ts
import { z } from "zod";
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";
import { BULK_DELETABLE_STATUSES } from "@/lib/appointments/bulk-eligibility";

export type ApptResult =
  | { ok: true; changedIds: string[] }
  | { ok: false; error: string };

// One booking as the operator saw it: its appointment ids and the status on
// screen when they ticked it. `from: null` = no expected status (the single-row
// buttons, whose job includes a deliberate revert).
interface BatchEntry {
  ids: ReadonlyArray<string>;
  from: string | null;
}

function flattenBatch(batch: ReadonlyArray<BatchEntry>): {
  ids: string[];
  idsByFrom: Map<string | null, string[]>;
} {
  const seen = new Set<string>();
  const idsByFrom = new Map<string | null, string[]>();
  for (const entry of batch) {
    for (const id of entry.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const list = idsByFrom.get(entry.from) ?? [];
      list.push(id);
      idsByFrom.set(entry.from, list);
    }
  }
  return { ids: [...seen], idsByFrom };
}

// Sibling ids per appointment WITHIN this batch, derived from booking_group_id
// on the server — the client's grouping is never what the audit trail records.
async function bookingSiblings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, string[]>> {
  const { data } = await supabase
    .from("appointments")
    .select("id, booking_group_id")
    .in("id", ids);
  const byGroup = new Map<string, string[]>();
  for (const row of data ?? []) {
    if (!row.booking_group_id) continue;
    const list = byGroup.get(row.booking_group_id) ?? [];
    list.push(row.id);
    byGroup.set(row.booking_group_id, list);
  }
  const out = new Map<string, string[]>();
  for (const row of data ?? []) {
    out.set(row.id, row.booking_group_id ? byGroup.get(row.booking_group_id)! : [row.id]);
  }
  return out;
}

const TOO_MANY = `Too many appointments in one go — the limit is ${MAX_BULK_RECORDS}. Select fewer bookings.`;

async function transitionGroups(
  batch: ReadonlyArray<BatchEntry>,
  to: Transition,
  extraMetadata?: Record<string, unknown>,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  const { ids, idsByFrom } = flattenBatch(batch);
  if (ids.length === 0) {
    return { ok: false, error: "No appointments to update." };
  }
  if (ids.length > MAX_BULK_RECORDS) {
    return { ok: false, error: TOO_MANY };
  }
  const allowed = ALLOWED_FROM[to];
  const notInState = `Appointment is not in a state we can mark "${to.replace(/_/g, " ")}".`;
  for (const from of idsByFrom.keys()) {
    if (from !== null && !allowed.includes(from)) return { ok: false, error: notInState };
  }

  // Moving to arrived or back to confirmed puts work back on the record;
  // cancelling or marking no-show does not, so those stay unguarded.
  // Walk-in appointments (patient_id NULL) pass. All-or-nothing on purpose:
  // one inactive patient refuses the whole batch and nothing is written.
  if (to === "arrived" || to === "confirmed") {
    const active = await assertAppointmentsPatientsActive(createAdminClient(), ids);
    if (!active.ok) return { ok: false, error: active.error };
  }

  const supabase = await createClient();
  const siblings = await bookingSiblings(supabase, ids);

  // One UPDATE per expected status. `eq("status", from)` is the stale-click
  // guard: ALLOWED_FROM alone would let a "Confirm" prepared on a pending
  // callback un-cancel a booking a colleague cancelled a second earlier.
  const writes = await Promise.all(
    [...idsByFrom].map(([from, groupIds]) =>
      supabase
        .from("appointments")
        .update({ status: to })
        .in("id", groupIds)
        .in("status", from === null ? allowed : [from])
        .select("id, patient_id"),
    ),
  );
  const failed = writes.find((w) => w.error);
  if (failed?.error) return { ok: false, error: failed.error.message };
  const data = writes.flatMap((w) => w.data ?? []);
  if (data.length === 0) return { ok: false, error: notInState };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  // One audit row per appointment so the trail per-row stays grep-able;
  // group_appointment_ids is the BOOKING's own siblings (server-derived),
  // bulk_batch_size is how many ids this call carried — a sweep is batch > group.
  await Promise.all(
    data.map((row) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: row.patient_id,
        action: `appointment.${to}`,
        resource_type: "appointment",
        resource_id: row.id,
        metadata: {
          actor_role: session.role,
          group_appointment_ids: siblings.get(row.id) ?? [row.id],
          bulk_batch_size: ids.length,
          ...extraMetadata,
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath("/staff/appointments");
  return { ok: true, changedIds: data.map((row) => row.id) };
}

// Single-booking wrapper — every existing caller (the row buttons,
// completeAppointmentFromVisitAction, completeArrivedAppointmentsForPatientAction)
// keeps calling this and is unaffected: no expected status, ALLOWED_FROM only.
async function transitionGroup(
  appointmentIds: ReadonlyArray<string>,
  to: Transition,
  extraMetadata?: Record<string, unknown>,
): Promise<ApptResult> {
  return transitionGroups([{ ids: appointmentIds, from: null }], to, extraMetadata);
}
```

Keep the `Transition`, `ALLOWED_FROM` and the four exported single-group actions exactly as they are.

- [ ] **Step 2: Add the bulk transition action**

Immediately after `revertToConfirmedAction`:

```ts
const BULK_TRANSITIONS = ["arrived", "no_show", "cancelled", "confirmed"] as const;
// Inputs from the client are untrusted: bookings as {ids, from}, and a target
// that can never be "completed" (only starting a visit completes a booking).
const BulkBatchSchema = z
  .array(z.object({ ids: z.array(z.string().uuid()).min(1), from: z.string().min(1) }))
  .min(1);

export async function bulkTransitionAction(batch: unknown, to: unknown): Promise<ApptResult> {
  const parsedBatch = BulkBatchSchema.safeParse(batch);
  const parsedTo = z.enum(BULK_TRANSITIONS).safeParse(to);
  if (!parsedBatch.success || !parsedTo.success) {
    return { ok: false, error: "Could not read the selection — refresh and try again." };
  }
  return transitionGroups(parsedBatch.data, parsedTo.data);
}
```

- [ ] **Step 3: Rewrite delete to audit the rows the delete returned, and add the bulk delete**

Replace `deleteAppointmentAction` with:

```ts
async function deleteGroups(batch: ReadonlyArray<BatchEntry>): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only." };
  }
  const { ids, idsByFrom } = flattenBatch(batch);
  if (ids.length === 0) {
    return { ok: false, error: "No appointments to delete." };
  }
  if (ids.length > MAX_BULK_RECORDS) {
    return { ok: false, error: TOO_MANY };
  }

  const supabase = await createClient();
  const siblings = await bookingSiblings(supabase, ids);
  // Audit from what the DELETE actually returned — never from a pre-read, so
  // two admins deleting overlapping selections cannot audit rows the other
  // one removed. With an expected status (bulk) a booking that changed since
  // selection is left alone and reported as unchanged.
  const writes = await Promise.all(
    [...idsByFrom].map(([from, groupIds]) => {
      let query = supabase.from("appointments").delete().in("id", groupIds);
      if (from !== null) query = query.eq("status", from);
      return query.select("id, patient_id, status, scheduled_at");
    }),
  );
  const failed = writes.find((w) => w.error);
  if (failed?.error) return { ok: false, error: failed.error.message };
  const deleted = writes.flatMap((w) => w.data ?? []);
  if (deleted.length === 0) {
    return { ok: false, error: "No matching appointments." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  await Promise.all(
    deleted.map((row) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: row.patient_id,
        action: "appointment.deleted",
        resource_type: "appointment",
        resource_id: row.id,
        metadata: {
          previous_status: row.status,
          scheduled_at: row.scheduled_at,
          group_appointment_ids: siblings.get(row.id) ?? [row.id],
          bulk_batch_size: ids.length,
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath("/staff/appointments");
  return { ok: true, changedIds: deleted.map((row) => row.id) };
}

// Single booking, any status — today's row-button behaviour (now audited from
// the returned rows).
export async function deleteAppointmentAction(
  appointmentIds: ReadonlyArray<string>,
): Promise<ApptResult> {
  return deleteGroups([{ ids: appointmentIds, from: null }]);
}

// Bulk bar: every entry must carry a non-completed expected status, which the
// delete enforces in the write — a booking that completed since selection
// is not deleted.
export async function bulkDeleteAction(batch: unknown): Promise<ApptResult> {
  const parsed = BulkBatchSchema.safeParse(batch);
  if (!parsed.success) {
    return { ok: false, error: "Could not read the selection — refresh and try again." };
  }
  if (parsed.data.some((entry) => !BULK_DELETABLE_STATUSES.includes(entry.from))) {
    return { ok: false, error: "Completed bookings cannot be deleted from here." };
  }
  return deleteGroups(parsed.data);
}
```

- [ ] **Step 4: Register the delete helper with the write-guard scanner**

In `src/lib/patients/write-guards.test.ts`, the `EXEMPT` map keys are `file:function`. The `appointments` delete write now lives in `deleteGroups`, so replace the existing `deleteAppointmentAction` entry (line ~134) with:

```ts
  [`src/app/(staff)/staff/(dashboard)/appointments/actions.ts:deleteGroups`]:
    "Deletes reduce work and stay unguarded, same reasoning as cancelAppointmentAction (Task 22 note); shared by deleteAppointmentAction and bulkDeleteAction.",
```

`transitionGroups` contains the `assertAppointmentsPatientsActive(` call, which matches `GUARD_PATTERN`, so it needs no entry; `bookingSiblings` only reads. If the test reports an unused/stale exemption for `deleteAppointmentAction`, remove that key — do not keep both.

- [ ] **Step 5: Run the checks**

Run: `npx vitest run src/lib/patients/write-guards.test.ts src/lib/appointments 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: PASS; typecheck clean. `transition-buttons.tsx` and `visits/new/actions.ts` only read `result.ok` / `result.error`, so the wider success shape compiles unchanged.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/actions.ts" src/lib/patients/write-guards.test.ts
git commit -m "feat(appointments): bulk transition/delete actions over booking groups; audit deletes from returned rows"
```

---

### Task 6: AppointmentsBulkBar

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx`

- [ ] **Step 1: Write the bar**

```tsx
// src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import {
  BULK_TARGET,
  bulkActionPlan,
  outcomeMessage,
  summariseOutcome,
  type BulkAction,
  type GroupInfo,
} from "@/lib/appointments/bulk-eligibility";
import { bulkDeleteAction, bulkTransitionAction } from "./actions";

interface Props {
  // Every booking group the page rendered, keyed by ApptGroup.key. Serialisable
  // — built by the server page; the selection context only holds keys.
  groupsByKey: Record<string, GroupInfo>;
  isAdmin: boolean;
}

const BUTTONS: Array<{
  action: BulkAction;
  label: string;
  verb: string;
  pastTense: string;
  variant: "success" | "brand" | "outline" | "destructive";
  confirm: ((n: number) => string) | null;
}> = [
  { action: "arrive", label: "Mark arrived", verb: "Marked", pastTense: "arrived", variant: "success", confirm: null },
  { action: "confirm", label: "Confirm", verb: "Confirmed", pastTense: "", variant: "brand", confirm: null },
  {
    action: "noShow", label: "No-show", verb: "Marked", pastTense: "no-show", variant: "outline",
    confirm: (n) => `Mark ${n} booking${n === 1 ? "" : "s"} as no-show?`,
  },
  {
    action: "cancel", label: "Cancel", verb: "Cancelled", pastTense: "", variant: "outline",
    confirm: (n) => `Cancel ${n} booking${n === 1 ? "" : "s"}? The patient is not notified automatically.`,
  },
  {
    action: "revert", label: "Revert to confirmed", verb: "Reverted", pastTense: "to confirmed", variant: "outline",
    confirm: (n) => `Put ${n} booking${n === 1 ? "" : "s"} back to confirmed?`,
  },
  {
    action: "delete", label: "Delete", verb: "Deleted", pastTense: "", variant: "destructive",
    confirm: (n) => `Delete ${n} booking${n === 1 ? "" : "s"} permanently? This cannot be undone.`,
  },
];

export function AppointmentsBulkBar({ groupsByKey, isAdmin }: Props) {
  const { state, clearKeys } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();

  const selected = [...state.keys()]
    .map((key) => ({ key, info: groupsByKey[key] }))
    .filter((g): g is { key: string; info: GroupInfo } => g.info !== undefined)
    .map((g) => ({ key: g.key, status: g.info.status, patientActive: g.info.patientActive }));
  const plan = bulkActionPlan(selected, isAdmin);
  const inactiveCount = selected.filter((g) => !g.patientActive).length;

  function run(button: (typeof BUTTONS)[number]) {
    const keys = plan[button.action].keys;
    if (keys.length === 0 || pending) return;
    if (button.confirm && !confirm(button.confirm(keys.length))) return;
    // Send each booking with the status the operator saw — the server writes
    // with eq("status", from), so a booking changed since then comes back unchanged.
    const batch = keys.map((key) => ({ ids: groupsByKey[key]!.ids, from: groupsByKey[key]!.status }));
    start(async () => {
      const result =
        button.action === "delete"
          ? await bulkDeleteAction(batch)
          : await bulkTransitionAction(batch, BULK_TARGET[button.action]);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      const outcome = summariseOutcome(keys, groupsByKey, result.changedIds);
      const message = outcomeMessage(button.verb, button.pastTense, outcome);
      if (message) alert(message.replace(/\s+\./g, "."));
      // Pruning wins (spec §4): clear everything sent; the alert is the record.
      clearKeys(keys);
      router.refresh();
    });
  }

  return (
    <BulkBar noun="booking">
      {inactiveCount > 0 ? (
        <span className="text-[11px] text-amber-700">
          {inactiveCount} skipped for Mark arrived, Confirm and Revert — patient record deleted
        </span>
      ) : null}
      {BUTTONS.map((button) => {
        const n = plan[button.action].keys.length;
        if (n === 0) return null;
        return (
          <Button
            key={button.action}
            type="button"
            size="sm"
            variant={button.variant}
            disabled={pending}
            onClick={() => run(button)}
          >
            {button.label} ({n})
          </Button>
        );
      })}
    </BulkBar>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx"
git commit -m "feat(appointments): bulk action bar"
```

---

### Task 7: Wire the page

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` — imports (top), `AppointmentsPage` body (~lines 379–815), `Section` (~819–897), `FlatTable` (~899–968), `GroupRow` (~970–1126)

- [ ] **Step 1: Imports**

Add after the existing `TransitionButtons` import:

```ts
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";
import type { GroupInfo } from "@/lib/appointments/bulk-eligibility";
import { AppointmentsBulkBar } from "./appointments-bulk-bar";
```

- [ ] **Step 2: Helpers next to `groupRows`** (module scope, after `groupRows`)

```ts
// Bulk selection: a row is a booking group; nothing acts on completed ones.
function isSelectableGroup(g: ApptGroup): boolean {
  return g.lead.status !== "completed";
}

function selectionEntry(g: ApptGroup): SelectionEntry {
  return { rowKey: g.key, kinds: [g.lead.status], weight: g.rows.length };
}

function selectableEntries(groups: readonly ApptGroup[]): SelectionEntry[] {
  return groups.filter(isSelectableGroup).map(selectionEntry);
}

function groupPatientActive(r: ApptRow): boolean {
  return isActivePatient({
    drm_id: r.patient_drm_id ?? "",
    deleted_at: r.patient_deleted_at,
    merged_into_id: r.patient_merged_into_id,
  });
}

function groupInfoMap(groups: readonly ApptGroup[]): Record<string, GroupInfo> {
  const out: Record<string, GroupInfo> = {};
  for (const g of groups) {
    if (!isSelectableGroup(g)) continue;
    out[g.key] = {
      ids: g.rows.map((row) => row.id),
      status: g.lead.status,
      patientActive: groupPatientActive(g.lead),
    };
  }
  return out;
}

function selectionLabel(g: ApptGroup): string {
  const who = g.lead.patient_name ?? g.lead.walk_in_name ?? "Walk-in";
  return g.rows.length > 1 ? `${who}, ${g.rows.length} services` : who;
}
```

Then in `GroupRow`, replace its inline `patientActive={isActivePatient({...})}` (three lines) with `patientActive={groupPatientActive(r)}` — one source for the rule.

- [ ] **Step 3: Build `resetKey` and `groupsByKey` in `AppointmentsPage`**

Right before the `return (` of `AppointmentsPage` (after `flatGroups` / the four `*Groups` are computed):

```ts
  // Any change to what the list shows or how it is ordered drops the
  // selection (SelectionProvider keys its state on this).
  const selectionResetKey = [
    isFlatView ? "flat" : "grouped",
    type,
    query,
    sp.sort ?? "",
    sp.dir ?? "",
    String(page),
    String(size),
    rawSource,
  ].join("|");
  const groupsByKey = groupInfoMap(
    isFlatView ? flatGroups : [...pendingGroups, ...walkInGroups, ...todayGroups, ...upcomingGroups],
  );
```

(Use the page's actual variable names if they differ — `flatGroups`, `pendingGroups`, `walkInGroups`, `todayGroups`, `upcomingGroups` are the names passed to `FlatTable` / the four `Section`s today.)

- [ ] **Step 4: Wrap the tables and mount the bar**

Change the block that starts `{isFlatView ? (` and ends with the fourth `</Section>` / `</>` so it is:

```tsx
      <SelectionProvider resetKey={selectionResetKey}>
        {isFlatView ? (
          <>
            {/* …unchanged truncated notice, FlatTable, ListPagination… */}
          </>
        ) : (
          <>
            {/* …unchanged four Sections… */}
          </>
        )}
        <AppointmentsBulkBar groupsByKey={groupsByKey} isAdmin={session.role === "admin"} />
      </SelectionProvider>
```

- [ ] **Step 5: Checkbox column in `Section`**

In `Section`, add as the FIRST `<th>`:

```tsx
              <th className="w-12 px-2 py-3">
                <SelectAllCheckbox
                  entries={selectableEntries(groups)}
                  label={`Select all bookings in ${title}`}
                />
              </th>
```

and change the empty-row `colSpan={6}` to `colSpan={7}`.

- [ ] **Step 6: Checkbox column in `FlatTable`**

Add as the FIRST header cell:

```tsx
            <th className="w-12 px-2 py-3">
              <SelectAllCheckbox entries={selectableEntries(groups)} label="Select all bookings on this page" />
            </th>
```

and change `colSpan={8}` to `colSpan={9}`.

- [ ] **Step 7: Checkbox cell in `GroupRow`**

Add as the FIRST `<td>` of the row (before the "Requested" cell):

```tsx
      <td className="px-2 py-2 align-middle">
        {isSelectableGroup(group) ? (
          <RowSelectCheckbox
            rowKey={group.key}
            kinds={[r.status]}
            weight={group.rows.length}
            label={selectionLabel(group)}
          />
        ) : null}
      </td>
```

- [ ] **Step 8: Run everything**

Run: `npm test 2>&1 | tail -8 && npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -5`
Expected: all green. If `staff-nav-config.test.ts` / `staff-page-titles.test.ts` complain, nothing here changes names — re-read the failure; it is not this change.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/page.tsx"
git commit -m "feat(appointments): row checkboxes, select-all per section and the bulk bar"
```

---

### Task 8: Docs — user guide v2.27, CLAUDE.md, skills

**Files:**
- Modify: `docs/drmed-user-guide.html` (lines ~250, ~483, ~491, ~1248)
- Modify: `CLAUDE.md` (the guide version line under "Key reference artifacts")
- Modify: `.claude/skills/drmed-staff-ui/SKILL.md` (§4 List pages)
- Modify: `.claude/skills/drmed-booking-and-intake/SKILL.md` (wherever it lists the appointments page files)

- [ ] **Step 1: Guide — Row actions line (~483)**

Append to the `<dd>` after `<kbd class="ui">+ Start visit</kbd>`:

```html
 · tick boxes at the start of each row → a bar at the bottom of the page acts on all ticked bookings
```

- [ ] **Step 2: Guide — new step after the Mark arrived step (~491)**

```html
      <li><p class="step-title">To act on several bookings at once, tick the boxes at the start of their rows.</p><p>A bar appears at the bottom of the page with only the actions that apply to what you ticked — <kbd class="ui">Mark arrived</kbd>, <kbd class="ui">No-show</kbd>, <kbd class="ui">Cancel</kbd>, <kbd class="ui">Confirm</kbd>, <kbd class="ui">Revert to confirmed</kbd> and, for admins, <kbd class="ui">Delete</kbd>. The number on each button is how many of the ticked bookings it will change; a booking it cannot change is left alone and the bar says why (for example a deleted patient record). The box in a section's header ticks every booking in that section. You can tick up to 100 bookings at a time; searching, sorting, filtering or changing page clears the ticks, and so does <kbd class="key">Esc</kbd>. If someone else changed a booking after you ticked it, the bar tells you how many were skipped instead of overwriting their change.</p></li>
```

- [ ] **Step 3: Guide — version bumps**

Line ~250: `User guide · v2.26` → `User guide · v2.27`.
Line ~1248: `v2.26 · 25 September 2026` → `v2.27 · 25 September 2026` (keep the rest of the sentence).

- [ ] **Step 4: CLAUDE.md**

Change `(v2.26, 25 Sep 2026)` to `(v2.27, 25 Sep 2026)` in the `docs/drmed-user-guide.html` bullet.

- [ ] **Step 5: drmed-staff-ui skill — §4 list pages**

Add a paragraph at the end of "## 4 · List pages":

```markdown
### Multi-select on a list — use the shared kit

`src/components/staff/row-selection/` is the ONE row-selection kit: `SelectionProvider`
(client; wraps the server-rendered tables; `resetKey` = a joined string of every list
param, because search-param navigation does not remount client state), `RowSelectCheckbox`
(`rowKey`/`kinds`/`weight`/`label`; prunes itself on unmount or kind change),
`SelectAllCheckbox` (header, indeterminate), `BulkBar` (sticky bottom, count, Clear,
Escape). Caps live in `src/lib/ui/bulk-selection.ts` (100 rows / 500 records, pure,
tested). A page adds a leading checkbox column, builds a serialisable `…ByKey` map for its
bar, and writes ONE bar component with page-specific buttons. Server actions take the
grouped ids, enforce their own cap and status/ownership predicates, audit one row per
record from the rows the write RETURNED, and return `changedIds` so the bar can report
partial results. Live example: `appointments/appointments-bulk-bar.tsx` +
`src/lib/appointments/bulk-eligibility.ts`. The visit page's Tests section predates the
kit and keeps its own copy (`visits/[id]/selection-context.tsx`); the HMO-claims pages are
client-state tables. Spec: `docs/superpowers/specs/2026-09-25-bulk-row-selection-design.md`.
```

- [ ] **Step 6: drmed-booking-and-intake skill**

Where the skill lists `appointments/transition-buttons.tsx` / `actions.ts`, add:

```markdown
- `appointments/appointments-bulk-bar.tsx` + `src/lib/appointments/bulk-eligibility.ts` — the
  multi-select bar. `bulkTransitionAction(groups, to)` / `bulkDeleteAction(groups)` take
  booking groups (`string[][]`), never `completed`; results carry `changedIds` and every
  audit row has `bulk_batch_size`. `ApptResult` success is `{ ok: true; changedIds }`.
```

- [ ] **Step 7: Commit**

```bash
git add docs/drmed-user-guide.html CLAUDE.md .claude/skills/drmed-staff-ui/SKILL.md .claude/skills/drmed-booking-and-intake/SKILL.md
git commit -m "docs: bulk selection on Appointments — guide v2.27, skills"
```

---

### Task 9: Browser acceptance (spec §9) and PR

**Files:** none (evidence goes in the PR description).

- [ ] **Step 1: Start the local stack and dev server**

Run from the worktree: `supabase status >/dev/null 2>&1 || supabase start` (OrbStack, never Docker Desktop), then `PORT=3007 npm run dev > /tmp/bulk-select-dev.log 2>&1 &` and wait for `Ready`. Seed a handful of bookings if the local DB has none: `npm run seed:test`.

- [ ] **Step 2: Walk the checklist with Playwright MCP (`browser_snapshot` / `browser_evaluate`; screenshots only where noted)** signed in as admin, then as reception:

1. Tick two rows → bar shows "2 bookings selected", buttons carry counts; header checkbox reads `indeterminate === true` via `browser_evaluate`; tick all → checked.
2. Press Escape → selection cleared. Open "+ New appointment", press Escape → the sheet closes, a selection made before opening it is still there.
3. Tick rows, change sort / page / type filter → selection gone.
4. Two tabs: tab B marks a ticked booking arrived; tab A "Mark arrived (2)" → alert "Marked 1 of 2 bookings arrived. 1 had already changed."; `select action, metadata from audit_log order by created_at desc limit 5` shows one `appointment.arrived` row for the changed id only, with `bulk_batch_size` and `group_appointment_ids` = that booking's own ids. Then the stale-Confirm race: tab A ticks a pending callback, tab B cancels it, tab A clicks "Confirm (1)" → "Confirmed 0 of 1 bookings. 1 had already changed." and the booking is still cancelled (the row's own ↶ Revert button can still un-cancel it deliberately).
5. Reception: no Delete button; admin: Delete with confirm; a completed booking has no checkbox.
6. Delete/merge a selected booking's patient (Admin › Patients) in tab B, then "Mark arrived" in tab A → refused with the inactive-patient message, no rows changed.
7. `browser_resize` to 390×844: bar visible and wraps; no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`). One screenshot here.

- [ ] **Step 3: Open the PR**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/bulk-select
gh pr create --title "feat(appointments): select several bookings and act on them at once" --body-file <(cat <<'EOF'
## What
Tick boxes on /staff/appointments (grouped and sorted views) and a bottom bar with Mark arrived / No-show / Cancel / Confirm / Revert / Delete over the selection. Introduces the shared row-selection kit (`src/components/staff/row-selection`, `src/lib/ui/bulk-selection.ts`) the queue and inbox PRs will reuse.

Spec: docs/superpowers/specs/2026-09-25-bulk-row-selection-design.md (§4, §5). No migration.

## Server
- `bulkTransitionAction(groups, to)` / `bulkDeleteAction(groups)` over booking groups; caps (100 rows client, 500 ids server); status predicate in every write; active-patient check stays all-or-nothing.
- `deleteAppointmentAction` now audits the rows the DELETE returned (was: a pre-read).
- `ApptResult` success carries `changedIds`; partial results are reported per booking.

## Checks
- `npm test && npm run typecheck && npm run lint` — green
- Browser acceptance (spec §9): <fill in from Task 9 step 2>

## Guide
v2.27 — §3 Appointments gains "act on several bookings at once".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## Self-review

- **Spec coverage.** §4 kit → Tasks 1–3 (reducer, provider with `resetKey`, checkbox pruning on kind change, select-all indeterminate, bar with Escape guard, `refusedCount` message). §5 → Tasks 4–7 (plan table, inactive skip note, `changedIds`, returned-row delete audit, `allowedStatuses` for bulk delete, `bulk_batch_size`, caps, `clearKeys` of changed + unchanged, `router.refresh()`), Task 8 (guide). §8 units + rollback → outcome messages in bookings; §9 → Task 9. Not in this PR by design: §6, §7, visit-page migration.
- **Placeholders.** None; every code step is complete. Task 7 step 3 names the page's real variables and says to match them if they differ.
- **Type consistency.** `SelectionEntry {rowKey, kinds, weight}` used identically in Tasks 1, 3, 7. `GroupInfo {ids, status, patientActive}` in Tasks 4, 6, 7. `ApptResult {ok:true, changedIds}` in Tasks 5, 6. `BULK_TARGET` keys = the five non-delete `BulkAction`s. `clearKeys(readonly string[])` in Tasks 2, 3, 6. `BatchEntry {ids, from}` in Task 5 matches the `{ ids, from }` objects the bar builds in Task 6 and `BulkBatchSchema`.
