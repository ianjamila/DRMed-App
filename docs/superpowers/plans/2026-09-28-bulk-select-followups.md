# Bulk-select follow-ups (all 10 items) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten "also worth considering" items left by bulk-select PR 1 (#238) and PR 2 (#245) in one PR: fixed bars everywhere, named outcomes, keyboard jump, dated callbacks shown once, whole-panel chemistry selection, server-checked 10-minute Undo, an audit filter for bulk actions, guarded fixture + browser-check scripts, and the guide-version rule.

**Architecture:** Everything builds on the shared kit in `src/components/staff/row-selection/` and pure modules in `src/lib/`. A new `FixedBottomBar` primitive replaces every `sticky bottom-0` bar in the staff shell. Bulk server actions stamp a per-call `bulk_batch_id` (plus the prior state) into the audit rows they already write; Undo reads those rows back — only the caller's own, only inside 10 minutes — so nothing about what to restore is trusted from the browser. Chemistry panels are identified as `panel:<visitId>:<reportGroupId>` and resolved to every live bench member on the server.

**Tech Stack:** Next.js 16 App Router (server actions), Supabase (PostgREST via supabase-js), React 19, Vitest (Node + `renderToStaticMarkup`), tsx scripts with `pg`, playwright-core (headless Chrome) for local browser checks.

**Owner decisions (2026-09-28, do not re-litigate):**
- Item 9 Undo covers ALL reversible bulk actions: Appointments Cancel / No-show / Mark arrived / Confirm / Revert to confirmed; Lab queue Claim / Unclaim / Delete. Appointment **Delete** stays permanent (hard delete — no Undo).
- Undo window: **10 minutes, server-checked**, same staff member only, only rows still in the state the bulk action left them. Restore targets come from `audit_log` via `bulk_batch_id`.
- Item 10: a chemistry panel = **whole panel** (visit + report group). Ticking it acts on every live bench member (requested / in progress, not a package header, not cancelled, not deleted) even the part on another page, all-or-nothing. The card shows the true test count.
- Item 6: a pending-callback booking that has a date lives **only in its date section** (Today / Next 30 days) with a "Callback needed" tag; the Pending callback section says "+N more with a date".

**Kit rules (from PR 1/2 — every task):** never reset selection by remounting (no React `key` on a provider / list); never `position: sticky` for a bottom bar inside the staff shell (`<main>` is `overflow-x-auto`, so it becomes the scroll container); every bulk write carries the state the operator SAW as a predicate; audit only rows a write RETURNED; each server action enforces its own caps before any query; vitest is Node + static render only — component behaviour is verified by the browser runner (Task 14/16).

**Process rules:** do NOT bump the user-guide version/date line (`docs/drmed-user-guide.html` header and CLAUDE.md line 21) in this PR — that happens at merge time (item 3). No migration in this PR. Run `npm test && npm run typecheck && npm run lint` before each commit that touches `src/`.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/components/staff/fixed-bottom-bar.tsx` | create | Viewport-fixed bottom slot + ResizeObserver spacer (the only way to pin a bar in the staff shell) |
| `src/components/staff/fixed-bottom-bar.test.tsx` | create | Static-render contract (fixed, md:left-64, z-30, print:hidden, no sticky) |
| `src/components/staff/no-bottom-sticky.test.ts` | create | Guard: no `sticky … bottom-*` under `src/app/(staff)` / `src/components/staff` (allowlist with reasons) |
| `src/components/staff/row-selection/bar-focus.ts` | create | Keyboard jump: `isBarShortcut`, `requestBarFocus`, `useBarFocus` hook |
| `src/components/staff/row-selection/bar-focus.test.ts` | create | Pure tests for the shortcut predicate + first-focusable selector |
| `src/components/staff/row-selection/bulk-bar.tsx` | modify | Uses FixedBottomBar + useBarFocus; aria-live count; Alt+B hint |
| `src/components/staff/row-selection/bulk-outcome.tsx` | create | Shared outcome panel (message, optional ↶ Undo with live countdown, Dismiss) |
| `src/components/staff/row-selection/row-select-checkbox.tsx`, `select-all-checkbox.tsx` | modify | Enter → jump to the bar |
| `src/lib/ui/bulk-outcome.ts` (+ `.test.ts`) | create | `formatBulkOutcome` — head sentence + every not-changed / not-sent row named |
| `src/lib/ui/bulk-undo.ts` (+ `.test.ts`) | create | Undo window, result type, `planAppointmentUndo`, `bucketAppointmentUndo`, `planQueueUndo`, `groupUndoSteps`, `undoOutcomeMessage` |
| `src/lib/audit/bulk-batch.ts` | create (server-only) | `loadOwnBatchRows` — the caller's own audit rows for one batch inside the window |
| `src/lib/audit/bulk-filter.ts` (+ `.test.ts`) | create | Audit page filters: `BULK_AUDIT_OR`, `parseBatchParam`, `batchAuditOr`, `batchIdOf` |
| `src/lib/appointments/bulk-eligibility.ts` (+ test) | modify | `GroupInfo.label`, `skippedInactiveKeys`, `bulkAppointmentsMessage` (replaces `outcomeMessage`) |
| `src/lib/appointments/callback-dedupe.ts` (+ `.test.ts`) | create | `withoutDatedCallbacks` |
| `src/lib/queue/bulk-queue.ts` (+ test) | modify | `panelKey`, `parsePanelKey`, `splitQueueKeys`; `batchId` on results; `bulkQueueMessage` on `formatBulkOutcome` |
| `src/lib/queue/panel-members.ts` | create (server-only) | `loadPanelMembers` — every live bench member of each panel |
| `src/lib/actions/visits/queue-restore-core.ts` | create (server-only) | `restoreTestRequestsForVisit` extracted from `restoreTestRequestsAction` |
| `src/lib/actions/visits/queue-deletion.ts` | modify | Panels in `deleteTestRequestsManyAction`; batch metadata; restore action calls the core |
| `src/app/(staff)/staff/(dashboard)/queue/actions.ts` | modify | Panels in claim/unclaim; batch metadata; `undoBulkQueueAction` |
| `src/app/(staff)/staff/(dashboard)/queue/page.tsx` | modify | Panel checkboxes, true member counts |
| `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx` | modify | Panels, shared outcome panel, Undo |
| `src/app/(staff)/staff/(dashboard)/appointments/actions.ts` | modify | Batch id + `previous_status` metadata; `undoBulkAppointmentsAction` |
| `src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx` | modify | Named outcome panel + Undo |
| `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` | modify | Dated callbacks once + tag; `label` in groupsByKey |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx`, `row-select-checkbox.tsx` | modify | FixedBottomBar + keyboard jump |
| `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/{hmo-claims-client,[providerId]/provider-detail-client,batches/new/new-batch-client}.tsx` | modify | FixedBottomBar (4 bars) |
| `src/app/(staff)/staff/(dashboard)/audit/page.tsx` | modify | Bulk-actions chip, `batch=` filter, "Whole batch" link |
| `scripts/lib/env-guard.ts` (+ test) | modify | `localOnlyProblems` + `refuseNonLocal` |
| `scripts/seed/bulk-select-fixtures.sql` | create | Re-runnable fixtures: visits 9101–9106, BSQ services, BSQ patients, appointments, website messages |
| `scripts/seed-bulk-select-fixtures.ts` | create | `npm run seed:bulk-fixtures [-- --as=<role>]` — local-only |
| `scripts/browser-check/lib.ts` | create | Guarded headless-Chrome helpers (sign-in, SQL, bar helpers, expect/summary) |
| `scripts/browser-check/bulk-select.ts` | create | `npm run check:bulk-select` — the whole bulk-select browser checklist, asserting |
| `package.json` | modify | two npm scripts |
| `CLAUDE.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `docs/drmed-user-guide.html` | modify | Guide-version rule; guide content (no version bump) |

---

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Confirm the worktree and a green baseline**

Run (from `~/Claude/DRMed/.worktrees/bulk-select-followups`):
```bash
git log --oneline -1 && npm test > tmp/t0-test.log 2>&1; echo "test exit $?"; npm run typecheck > tmp/t0-tc.log 2>&1; echo "tc exit $?"
```
Expected: HEAD `d43397d4`, both exit 0. If not, stop and report — do not start on a red baseline.

---

### Task 1: `FixedBottomBar` primitive + no-bottom-sticky guard (item 1, part 1)

**Files:**
- Create: `src/components/staff/fixed-bottom-bar.tsx`
- Create: `src/components/staff/fixed-bottom-bar.test.tsx`
- Create: `src/components/staff/no-bottom-sticky.test.ts`
- Modify: `src/components/staff/row-selection/bulk-bar.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx:130-150` (outcome panel wrapper)

- [ ] **Step 1: Write the failing tests**

`src/components/staff/fixed-bottom-bar.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixedBottomBar } from "./fixed-bottom-bar";

describe("FixedBottomBar", () => {
  it("pins to the viewport past the sidebar, under dialogs, never in print", () => {
    const html = renderToStaticMarkup(
      <FixedBottomBar>
        <p>bar</p>
      </FixedBottomBar>,
    );
    expect(html).toContain("fixed inset-x-0 bottom-0 z-30");
    expect(html).toContain("md:left-64");
    expect(html).toContain("print:hidden");
    expect(html).not.toMatch(/\bsticky\b/);
    expect(html).toContain("<p>bar</p>");
    // The in-flow spacer that keeps the last rows visible comes first.
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf("fixed inset-x-0"));
  });
});
```

`src/components/staff/no-bottom-sticky.test.ts`:
```ts
// Guard for the kit rule "never sticky inside the staff shell": the shell's
// <main> is overflow-x-auto (staff-shell.tsx), which makes it the scroll
// container a sticky element resolves against — and <main> never scrolls, so
// a `sticky bottom-0` bar just sits under the content. Bottom bars use
// FixedBottomBar instead. Horizontal sticky (`sticky left-0` table columns)
// and sticky headers inside their own scroll container (modals, drawers) are
// fine and are not matched / are allowlisted.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src/app/(staff)", "src/components/staff"];
const ALLOW: Record<string, string> = {
  // Inside the drawer's own overflow-y-auto panel, not the shell's <main>.
  "src/app/(staff)/staff/(dashboard)/admin/payroll/runs/[id]/_components/earning-deduction-drawer.tsx":
    "drawer is its own scroll container",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("staff shell bottom bars", () => {
  it("never use sticky bottom positioning", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = relative(process.cwd(), file);
        if (ALLOW[rel]) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\bsticky\b[^"'`]*\bbottom-/.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/staff/fixed-bottom-bar.test.tsx src/components/staff/no-bottom-sticky.test.ts`
Expected: FAIL — `fixed-bottom-bar` module not found; the guard lists 5 offenders (visit bar + 4 HMO bars). The guard stays red until Task 2.

- [ ] **Step 3: Create the primitive**

`src/components/staff/fixed-bottom-bar.tsx`:
```tsx
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Viewport-fixed bottom slot for every staff selection / action bar.
// `sticky` can't work here: the staff shell's <main> is deliberately
// `overflow-x-auto` so wide tables scroll on screen (staff-shell.tsx), and
// setting overflow-x on an element makes the browser compute overflow-y too
// — so <main> becomes the scroll container sticky resolves against, and
// since <main> itself never scrolls (the window does), a sticky bar just sits
// at the bottom of its content instead of tracking the viewport. Fixing it to
// the viewport (offset past the md:w-64 sidebar) sidesteps that. An in-flow
// spacer — sized to the fixed bar's live border-box height via
// ResizeObserver, since the bar wraps to several lines on narrow screens —
// keeps the last rows from being covered. z-30 must stay under any
// dialog/sheet overlay (z-50 in dialog.tsx/sheet.tsx, z-[70] in
// confirm-dialog.tsx) so opening one on top of a selection still works.
// Mount it only while the bar should show (callers render it conditionally),
// so the spacer disappears with it.
export function FixedBottomBar({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSpacerHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div aria-hidden="true" style={{ height: spacerHeight }} />
      <div
        ref={wrapperRef}
        className="fixed inset-x-0 bottom-0 z-30 px-4 pb-3 md:left-64 print:hidden"
      >
        <div className="mx-auto w-full max-w-screen-2xl">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Move the kit bar and the queue outcome panel onto it**

In `src/components/staff/row-selection/bulk-bar.tsx`: delete the long positioning comment (it now lives in fixed-bottom-bar.tsx; leave a one-line pointer `// Positioning: see FixedBottomBar.`), delete `wrapperRef`, `spacerHeight` and the ResizeObserver effect, import `FixedBottomBar` from `@/components/staff/fixed-bottom-bar`, and render:
```tsx
  if (count === 0) return null;

  return (
    <FixedBottomBar>
      <Panel
        role="region"
        aria-label="Selected rows"
        className="flex flex-wrap items-center gap-3 p-3 shadow-lg max-sm:[&_button]:h-9"
      >
        {/* …existing count / Clear / refused span and children div unchanged… */}
      </Panel>
    </FixedBottomBar>
  );
```
Keep the Escape effect exactly as is (Task 3 extends it). Remove now-unused `useRef`/`useState` imports.

In `queue-bulk-bar.tsx`, replace the hand-rolled wrapper around the outcome Panel:
```tsx
    return (
      <FixedBottomBar>
        <Panel role="status" className="flex items-start gap-3 p-3 text-xs shadow-lg">
          {/* …unchanged… */}
        </Panel>
      </FixedBottomBar>
    );
```
and drop the comment that says "Same fixed slot the bar uses". (Task 4 replaces this panel with the shared component; this step only removes the duplicate positioning.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/staff/fixed-bottom-bar.test.tsx && npm run typecheck`
Expected: PASS. (`no-bottom-sticky.test.ts` still FAILS — fixed in Task 2.)

- [ ] **Step 6: Commit**
```bash
git add src/components/staff/fixed-bottom-bar.tsx src/components/staff/fixed-bottom-bar.test.tsx src/components/staff/no-bottom-sticky.test.ts src/components/staff/row-selection/bulk-bar.tsx "src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx"
git commit -m "feat(staff): FixedBottomBar primitive shared by the selection bars"
```
(End every commit message in this plan with the `Co-Authored-By` line from the session's attribution reminder.)

---

### Task 2: Visit-page Tests bar and the four HMO-claims bars onto `FixedBottomBar` (item 1, part 2)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx:158-274`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/hmo-claims-client.tsx:1110` and `:1503`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/provider-detail-client.tsx:449`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/new/new-batch-client.tsx:251`

- [ ] **Step 1: Visit bar**

Wrap the returned `<Panel role="region" aria-label="Bulk actions" …>` in `<FixedBottomBar>…</FixedBottomBar>` and change its className from
`"sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-3 p-3 shadow-sm"` to
`"flex flex-wrap items-center gap-3 p-3 shadow-lg"`. The early `if (totalSelected === 0) return null;` (line 78) stays, so the spacer only exists while the bar shows.

- [ ] **Step 2: HMO bars**

For each of the four `Panel className="sticky bottom-0 z-10 …"` footers: wrap in `<FixedBottomBar>` and replace `sticky bottom-0 z-10 ` with nothing and `shadow-sm` with `shadow-lg` (keep `flex flex-wrap items-center justify-between gap-3 p-3`/`p-4`). The two in `hmo-claims-client.tsx` already sit inside `{selected.size > 0 && (…)}`; `provider-detail-client.tsx` and `new-batch-client.tsx` render always — keep that (an always-visible footer with its spacer is the intended behaviour; its "Select items to start" / disabled Save state already explains the empty case).

- [ ] **Step 3: Check overlays still sit above the bars**

Run: `grep -n "fixed inset-0" "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/hmo-claims-client.tsx" "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/provider-detail-client.tsx" "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/new/new-batch-client.tsx"`
Expected: every hand-rolled modal overlay uses `z-40` or higher. If one uses `z-10`/`z-20`/`z-30`, raise it to `z-50` (the bar is `z-30`; a modal under it would be covered).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/staff/no-bottom-sticky.test.ts && npm run typecheck && npm run lint > tmp/t2-lint.log 2>&1; echo lint $?`
Expected: guard PASS (0 offenders), typecheck and lint exit 0.

- [ ] **Step 5: Commit**
```bash
git add -A "src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx" "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims"
git commit -m "fix(staff): visit Tests bar and HMO-claims bars pin to the viewport instead of sticky"
```

---

### Task 3: Keyboard — jump to the selection actions (item 7)

Behaviour:
- **Alt+B** (⌥B on a Mac; matched on `event.code === "KeyB"` so the Mac's `∫` character does not matter) anywhere on the page, while a bar is showing and focus is not in a text field → focus moves to the bar's first enabled action button.
- **Enter** on any selection checkbox (row or header, kit and visit page) → same jump. `preventDefault()` so Enter never submits an enclosing form.
- When the bar closes (Escape / Clear / selection emptied) while focus is inside it, focus returns to the element that was focused before the jump, if it is still in the document.
- The bar region carries `aria-keyshortcuts="Alt+B"`, the count is `aria-live="polite"` (the visit bar already is — match it), and on `sm+` the count line shows a small hint `· Alt+B`.

**Files:**
- Create: `src/components/staff/row-selection/bar-focus.ts`
- Create: `src/components/staff/row-selection/bar-focus.test.ts`
- Modify: `src/components/staff/row-selection/bulk-bar.tsx`, `row-select-checkbox.tsx`, `select-all-checkbox.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx`, `src/app/(staff)/staff/(dashboard)/visits/[id]/row-select-checkbox.tsx`

- [ ] **Step 1: Write the failing test**

`src/components/staff/row-selection/bar-focus.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FOCUSABLE_IN_BAR, isBarShortcut } from "./bar-focus";

const ev = (over: Partial<Parameters<typeof isBarShortcut>[0]>) => ({
  code: "KeyB",
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("isBarShortcut", () => {
  it("matches Alt+B by physical key (Mac ⌥B types ∫)", () => {
    expect(isBarShortcut(ev({}))).toBe(true);
  });
  it("ignores other modifiers and keys", () => {
    expect(isBarShortcut(ev({ altKey: false }))).toBe(false);
    expect(isBarShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ shiftKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ code: "KeyN" }))).toBe(false);
  });
});

describe("FOCUSABLE_IN_BAR", () => {
  it("targets enabled controls only", () => {
    expect(FOCUSABLE_IN_BAR).toContain("button:not([disabled])");
    expect(FOCUSABLE_IN_BAR).toContain("select:not([disabled])");
    expect(FOCUSABLE_IN_BAR).not.toContain("input[type=checkbox]");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/staff/row-selection/bar-focus.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `bar-focus.ts`**

```ts
"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

// Keyboard jump between a list's checkboxes and its selection bar (bulk-select
// follow-ups item 7). Decoupled through a DOM event so the kit bar and the
// visit page's own bar (a separate selection context) share one mechanism:
// checkboxes call requestBarFocus() on Enter, and whichever bar is mounted
// listens for it and for Alt+B.

export const BAR_FOCUS_EVENT = "staff:focus-selection-bar";

/** First-choice targets inside the bar: enabled action controls, in DOM order. */
export const FOCUSABLE_IN_BAR =
  "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";

export function isBarShortcut(e: {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.code === "KeyB" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

export function isTextTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
}

/** Called by a selection checkbox on Enter. */
export function requestBarFocus(): void {
  document.dispatchEvent(new CustomEvent(BAR_FOCUS_EVENT));
}

/**
 * Wires a mounted bar: Alt+B and BAR_FOCUS_EVENT move focus into `barRef`;
 * the element focused before the jump is remembered, and restoreFocus() puts
 * focus back there (call it before the bar closes). Returns restoreFocus.
 */
export function useBarFocus(barRef: RefObject<HTMLElement | null>, active: boolean): () => void {
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const jump = () => {
      const bar = barRef.current;
      if (!bar) return;
      const current = document.activeElement;
      if (current instanceof HTMLElement && !bar.contains(current)) returnTo.current = current;
      const target = bar.querySelector<HTMLElement>(FOCUSABLE_IN_BAR) ?? bar;
      target.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isBarShortcut(e) || isTextTarget(e.target)) return;
      e.preventDefault();
      jump();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener(BAR_FOCUS_EVENT, jump);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener(BAR_FOCUS_EVENT, jump);
    };
  }, [active, barRef]);

  // Stable identity: callers list it in effect / useCallback deps.
  return useCallback(() => {
    const bar = barRef.current;
    const el = returnTo.current;
    returnTo.current = null;
    if (!bar || !bar.contains(document.activeElement)) return;
    if (el && el.isConnected) el.focus();
  }, [barRef]);
}
```
Then in `bulk-bar.tsx`, replace the local `isTextTarget` with the import from `./bar-focus` (delete the local copy).

- [ ] **Step 4: Wire the kit bar**

In `BulkBar`:
```tsx
  const barRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useBarFocus(barRef, count > 0);
  const clearAndReturn = useCallback(() => {
    restoreFocus();
    clear();
  }, [restoreFocus, clear]);
```
Use `clearAndReturn` in the Escape handler (instead of `clear()`) and in the Clear button's `onClick`. Put `ref={barRef}`, `tabIndex={-1}` and `aria-keyshortcuts="Alt+B"` on the `Panel` (Panel spreads props onto its `div`; React 19 passes `ref` as a prop). Change the count wrapper to `<div aria-live="polite" className="text-xs …">` and append, after the Clear button:
```tsx
              <span className="hidden text-[color:var(--color-brand-text-soft)] sm:inline"> · Alt+B</span>
```
When an action succeeds, `clearKeys` empties the selection and the bar unmounts with focus inside it — focus falls to `<body>`, and Task 4's outcome panel takes it from there (it focuses itself when focus is on `<body>`). Do NOT add a restore-on-unmount effect: by the time it runs the bar is gone, and the outcome panel is the right landing spot.

- [ ] **Step 5: Enter on the checkboxes**

In kit `row-select-checkbox.tsx` and `select-all-checkbox.tsx`, and in `visits/[id]/row-select-checkbox.tsx`, add to the `<input type="checkbox">`:
```tsx
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          requestBarFocus();
        }}
```
importing `requestBarFocus` from `@/components/staff/row-selection/bar-focus` (kit files: `./bar-focus`).

- [ ] **Step 6: Wire the visit bar**

In `visits/[id]/bulk-action-bar.tsx`: `const barRef = useRef<HTMLDivElement>(null); const restoreFocus = useBarFocus(barRef, totalSelected > 0);` — hooks must be called before the `if (totalSelected === 0) return null;` early return (move that return below the hooks if needed). Put `ref={barRef} tabIndex={-1} aria-keyshortcuts="Alt+B"` on its Panel; call `restoreFocus()` first in the Clear button's onClick. Add the same `· Alt+B` hint after the count.

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `npx vitest run src/components/staff && npm run typecheck && npm run lint > tmp/t3-lint.log 2>&1; echo lint $?`
Expected: PASS / 0. (Behaviour is proven by the browser runner, Task 14 checks K1–K4.)

- [ ] **Step 8: Commit**
```bash
git add src/components/staff/row-selection "src/app/(staff)/staff/(dashboard)/visits/[id]"
git commit -m "feat(staff): Alt+B / Enter jump from a selection to its action bar, focus returns on close"
```

---

### Task 4: Shared outcome text + panel; Appointments names every booking (item 2)

**Files:**
- Create: `src/lib/ui/bulk-outcome.ts`, `src/lib/ui/bulk-outcome.test.ts`
- Create: `src/components/staff/row-selection/bulk-outcome.tsx`
- Modify: `src/lib/queue/bulk-queue.ts` (`bulkQueueMessage` delegates; output unchanged)
- Modify: `src/lib/appointments/bulk-eligibility.ts`, `src/lib/appointments/bulk-eligibility.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx`, `appointments/page.tsx` (`groupInfoMap` adds `label`)
- Modify: `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx` (use the shared panel)

- [ ] **Step 1: Write the failing tests**

`src/lib/ui/bulk-outcome.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatBulkOutcome } from "./bulk-outcome";

const bookings = { one: "booking", many: "bookings" };

describe("formatBulkOutcome", () => {
  it("all changed: one sentence", () => {
    expect(
      formatBulkOutcome({ verb: "Cancelled", noun: bookings, sent: 3, changed: 3, notChanged: [] }),
    ).toBe("Cancelled 3 bookings.");
  });
  it("singular noun and tail", () => {
    expect(
      formatBulkOutcome({ verb: "Marked", tail: "as no-show", noun: bookings, sent: 1, changed: 1, notChanged: [] }),
    ).toBe("Marked 1 booking as no-show.");
  });
  it("names every row not changed, then every row never sent", () => {
    expect(
      formatBulkOutcome({
        verb: "Marked",
        tail: "arrived",
        noun: bookings,
        sent: 3,
        changed: 1,
        notChanged: [
          { label: "Santos, Maria", reason: "had already changed — refresh to see its status" },
          { label: "Cruz, Ana, 3 services", reason: "partly changed — open it to check" },
        ],
        notSent: [{ label: "Reyes, Jo", reason: "patient record deleted or merged" }],
      }),
    ).toBe(
      [
        "Marked 1 of 3 bookings arrived.",
        "Not changed (2):",
        "• Santos, Maria: had already changed — refresh to see its status",
        "• Cruz, Ana, 3 services: partly changed — open it to check",
        "Skipped (1):",
        "• Reyes, Jo: patient record deleted or merged",
      ].join("\n"),
    );
  });
  it("nothing changed", () => {
    expect(
      formatBulkOutcome({ verb: "Claimed", noun: { one: "test", many: "tests" }, sent: 2, changed: 0, notChanged: [] }),
    ).toBe("Nothing claimed.");
  });
});
```

Add to `src/lib/appointments/bulk-eligibility.test.ts` (and delete the old `outcomeMessage` cases in the `summariseOutcome / outcomeMessage` describe — keep the `summariseOutcome` ones; rename the describe to `summariseOutcome / bulkAppointmentsMessage`):
```ts
import { bulkAppointmentsMessage } from "./bulk-eligibility";

describe("bulkAppointmentsMessage", () => {
  const groups = {
    a: { ids: ["a1"], status: "confirmed", patientActive: true, label: "Santos, Maria" },
    b: { ids: ["b1"], status: "confirmed", patientActive: true, label: "Lim, Ben" },
    c: { ids: ["c1", "c2"], status: "confirmed", patientActive: true, label: "Cruz, Ana, 2 services" },
    d: { ids: ["d1"], status: "confirmed", patientActive: false, label: "Reyes, Jo" },
  };
  it("names changed-elsewhere, partly-changed and never-sent bookings", () => {
    const msg = bulkAppointmentsMessage(
      { verb: "Marked", pastTense: "arrived" },
      { changed: ["a"], partly: ["c"], unchanged: ["b"] },
      groups,
      ["d"],
    );
    expect(msg).toBe(
      [
        "Marked 1 of 3 bookings arrived.",
        "Not changed (2):",
        "• Cruz, Ana, 2 services: partly changed — open it to check",
        "• Lim, Ben: had already changed — refresh to see its status",
        "Skipped (1):",
        "• Reyes, Jo: patient record deleted or merged",
      ].join("\n"),
    );
  });
  it("falls back to 'A booking' for a key the page no longer renders", () => {
    expect(
      bulkAppointmentsMessage({ verb: "Cancelled", pastTense: "" }, { changed: [], partly: [], unchanged: ["zz"] }, groups, []),
    ).toBe("Nothing cancelled.\nNot changed (1):\n• A booking: had already changed — refresh to see its status");
  });
});

describe("bulkActionPlan skippedInactiveKeys", () => {
  it("lists the inactive bookings each patient-bound button leaves out", () => {
    const plan = bulkActionPlan(
      [
        { key: "a", status: "confirmed", patientActive: true },
        { key: "d", status: "confirmed", patientActive: false },
      ],
      false,
    );
    expect(plan.arrive.skippedInactiveKeys).toEqual(["d"]);
    expect(plan.cancel.skippedInactiveKeys).toEqual([]);
  });
});
```
(Merge the `bulkActionPlan` import into the file's existing import from `./bulk-eligibility`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ui/bulk-outcome.test.ts src/lib/appointments/bulk-eligibility.test.ts` — Expected: FAIL (missing module / exports).

- [ ] **Step 3: Implement `src/lib/ui/bulk-outcome.ts`**

```ts
// The text every bulk bar shows after an action: a head sentence, then EVERY
// row that was not changed — named, with why — and every row the bar never
// sent. The bar clears the selection afterwards, so this text is the only
// record of what was left alone: never cap or summarise it (Codex P2 on #245).

export interface OutcomeLine {
  label: string;
  reason: string;
}

export interface BulkOutcomeInput {
  /** Past tense, capitalised: "Claimed", "Cancelled", "Marked". */
  verb: string;
  /** Words after the noun: "arrived", "as no-show". */
  tail?: string;
  noun: { one: string; many: string };
  sent: number;
  changed: number;
  notChanged: readonly OutcomeLine[];
  /** Rows the bar left out before sending (e.g. an inactive patient for Mark arrived). */
  notSent?: readonly OutcomeLine[];
}

function counted(n: number, noun: { one: string; many: string }): string {
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

export function formatBulkOutcome(input: BulkOutcomeInput): string {
  const tail = input.tail ? ` ${input.tail}` : "";
  const head =
    input.changed === 0
      ? `Nothing ${input.verb.toLowerCase()}${tail}.`
      : input.changed === input.sent
        ? `${input.verb} ${counted(input.changed, input.noun)}${tail}.`
        : `${input.verb} ${input.changed} of ${counted(input.sent, input.noun)}${tail}.`;
  const lines = [head];
  const section = (title: string, rows: readonly OutcomeLine[] | undefined) => {
    if (!rows || rows.length === 0) return;
    lines.push(`${title} (${rows.length}):`, ...rows.map((r) => `• ${r.label}: ${r.reason}`));
  };
  section("Not changed", input.notChanged);
  section("Skipped", input.notSent);
  return lines.join("\n");
}
```

Rewrite `bulkQueueMessage` in `src/lib/queue/bulk-queue.ts` on top of it (its existing tests must still pass unchanged):
```ts
export function bulkQueueMessage(
  verb: string,
  sentCount: number,
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[] },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string {
  return formatBulkOutcome({
    verb,
    noun: { one: "test", many: "tests" },
    sent: sentCount,
    changed: result.changedIds.length,
    notChanged: result.skipped.map((s) => ({
      label: rowsByKey[s.id]?.label ?? "A test",
      reason: s.reason,
    })),
  });
}
```
(Delete the private `tests()` helper; import `formatBulkOutcome` from `@/lib/ui/bulk-outcome`.)

- [ ] **Step 4: Appointments eligibility changes**

In `src/lib/appointments/bulk-eligibility.ts`:
- `BulkPlanEntry` gains `skippedInactiveKeys: string[]`; `bulkActionPlan` initialises it to `[]` and pushes `group.key` wherever it increments `skippedInactive`.
- `GroupInfo` gains `label: string` — "how the outcome message names the booking".
- Replace `outcomeMessage` with:
```ts
const PARTLY = "partly changed — open it to check";
const ALREADY = "had already changed — refresh to see its status";
const INACTIVE = "patient record deleted or merged";

/** Always a message (the outcome panel is also where Undo lives). */
export function bulkAppointmentsMessage(
  button: { verb: string; pastTense: string },
  outcome: Outcome,
  groupsByKey: Readonly<Record<string, GroupInfo>>,
  notSentKeys: readonly string[],
): string {
  const label = (key: string) => groupsByKey[key]?.label ?? "A booking";
  return formatBulkOutcome({
    verb: button.verb,
    tail: button.pastTense || undefined,
    noun: { one: "booking", many: "bookings" },
    sent: outcome.changed.length + outcome.partly.length + outcome.unchanged.length,
    changed: outcome.changed.length,
    notChanged: [
      ...outcome.partly.map((key) => ({ label: label(key), reason: PARTLY })),
      ...outcome.unchanged.map((key) => ({ label: label(key), reason: ALREADY })),
    ],
    notSent: notSentKeys.map((key) => ({ label: label(key), reason: INACTIVE })),
  });
}
```

In `appointments/page.tsx` `groupInfoMap`, add `label: selectionLabel(g),` to each entry.

- [ ] **Step 5: Shared outcome panel component**

`src/components/staff/row-selection/bulk-outcome.tsx`:
```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";

export interface OutcomeUndo {
  /** Epoch ms when the action finished; the button hides when the window closes. */
  doneAt: number;
  windowMs: number;
  pending: boolean;
  onUndo: () => void;
}

// What a bulk bar shows after an action, in the bar's own fixed slot: the
// full outcome text (every skipped row named), an optional ↶ Undo that
// disappears when its window closes, and Dismiss. Takes focus when the bar
// that ran the action has just unmounted (focus fell to <body>), so keyboard
// users land on Undo / Dismiss instead of the top of the page.
export function BulkOutcomePanel({
  message,
  undo,
  onDismiss,
}: {
  message: string;
  undo?: OutcomeUndo | null;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, []);

  const open = undo ? now - undo.doneAt < undo.windowMs : false;
  useEffect(() => {
    if (!undo || !open) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [undo, open]);
  const minutesLeft = undo ? Math.max(1, Math.ceil((undo.windowMs - (now - undo.doneAt)) / 60_000)) : 0;

  return (
    <FixedBottomBar>
      <Panel
        ref={ref}
        tabIndex={-1}
        role="status"
        className="flex items-start gap-3 p-3 text-xs shadow-lg"
      >
        <p className="max-h-48 flex-1 overflow-y-auto whitespace-pre-line text-[color:var(--color-brand-text-mid)]">
          {message}
        </p>
        {undo && open ? (
          <button
            type="button"
            onClick={undo.onUndo}
            disabled={undo.pending}
            title={`Available for about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}`}
            className="min-h-[44px] whitespace-nowrap rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 font-semibold text-[color:var(--color-brand-navy)] disabled:opacity-50"
          >
            {undo.pending ? "Undoing…" : "↶ Undo"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 font-semibold"
        >
          Dismiss
        </button>
      </Panel>
    </FixedBottomBar>
  );
}
```
(Task 11 passes `undo`; until then callers pass none.)

- [ ] **Step 6: Queue bar uses it**

In `queue-bulk-bar.tsx` replace the whole `if (count === 0) { if (!outcome) return null; return (…) }` block with:
```tsx
  if (count === 0) {
    if (!outcome) return null;
    return <BulkOutcomePanel message={outcome} onDismiss={() => setOutcome(null)} />;
  }
```
and remove the now-unused `FixedBottomBar` import there.

- [ ] **Step 7: Appointments bar shows the named outcome**

In `appointments-bulk-bar.tsx`:
- `noShow` button: `pastTense: "as no-show"` (so the text reads "Marked 3 bookings as no-show.").
- Add `const [outcome, setOutcome] = useState<string | null>(null);` and, like the queue bar, the render-time rule `if (count > 0 && outcome !== null) setOutcome(null);` (read `count` from `useRowSelection()`).
- In `run()`, after a successful result:
```ts
      const outcome = summariseOutcome(keys, groupsByKey, result.changedIds);
      const notSent = plan[button.action].skippedInactiveKeys;
      setOutcome(bulkAppointmentsMessage(button, outcome, groupsByKey, notSent));
      // Pruning wins (spec §4): clear everything sent — and the inactive ones the
      // button left out, which the message now names — the panel is the record.
      clearKeys([...keys, ...notSent]);
      router.refresh();
```
  Delete the `alert(message)` path. Keep `alert(result.error)` for `!result.ok` (nothing, or a partial, committed — the selection is kept for retry; that path is unchanged).
- Before the `return <BulkBar …>`: `if (count === 0) return outcome ? <BulkOutcomePanel message={outcome} onDismiss={() => setOutcome(null)} /> : null;` — BulkBar already returns null at count 0, so this only adds the panel.
- Imports: `useState`, `BulkOutcomePanel`, `bulkAppointmentsMessage` (drop `outcomeMessage`).

- [ ] **Step 8: Run tests, typecheck, lint**

Run: `npx vitest run src/lib/ui src/lib/queue src/lib/appointments && npm run typecheck && npm run lint > tmp/t4-lint.log 2>&1; echo lint $?`
Expected: PASS / 0. `grep -rn "outcomeMessage" src` → no hits.

- [ ] **Step 9: Commit**
```bash
git add src/lib/ui/bulk-outcome.ts src/lib/ui/bulk-outcome.test.ts src/components/staff/row-selection/bulk-outcome.tsx src/lib/queue/bulk-queue.ts src/lib/appointments "src/app/(staff)/staff/(dashboard)/appointments" "src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx"
git commit -m "feat(appointments): bulk outcome names every booking left unchanged or skipped"
```

---

### Task 5: Dated pending callbacks appear once, with a tag (item 6)

**Files:**
- Create: `src/lib/appointments/callback-dedupe.ts`, `src/lib/appointments/callback-dedupe.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` (~lines 548–575, the Pending/Today/Next-30 `Section`s, `GroupRow` ~1186)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { withoutDatedCallbacks } from "./callback-dedupe";

const g = (key: string) => ({ key });

describe("withoutDatedCallbacks", () => {
  it("drops a pending callback that a dated section also loaded", () => {
    const out = withoutDatedCallbacks([g("a"), g("b"), g("c")], [[g("b")], [g("c"), g("x")]]);
    expect(out.pending.map((x) => x.key)).toEqual(["a"]);
    expect(out.moved.map((x) => x.key)).toEqual(["b", "c"]);
  });
  it("keeps everything when no dated section has it", () => {
    const out = withoutDatedCallbacks([g("a")], [[], []]);
    expect(out.pending.map((x) => x.key)).toEqual(["a"]);
    expect(out.moved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/appointments/callback-dedupe.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// A pending-callback booking that already has a requested date is loaded
// twice: by loadPendingCallback (by status) and by loadScheduledRange (by
// date), so it used to render in Pending callback AND in Today / Next 30
// days — two checkboxes, double-counted tabs. Owner decision 2026-09-28: it
// lives ONLY in its date section, where the row carries a "Callback needed"
// tag. Pending callback keeps the undated ones (and any dated before today,
// which no dated section loads) and says how many moved.
export function withoutDatedCallbacks<G extends { key: string }>(
  pending: readonly G[],
  dated: ReadonlyArray<readonly G[]>,
): { pending: G[]; moved: G[] } {
  const datedKeys = new Set<string>();
  for (const list of dated) for (const group of list) datedKeys.add(group.key);
  const kept: G[] = [];
  const moved: G[] = [];
  for (const group of pending) (datedKeys.has(group.key) ? moved : kept).push(group);
  return { pending: kept, moved };
}
```

- [ ] **Step 4: Apply in the page**

Right after `const allUpcomingGroups = groupRows(upcoming);`:
```ts
  // A dated pending callback shows once, in its date section (callback-dedupe.ts).
  const callbackSplit = withoutDatedCallbacks(groupRows(pending), [allTodayGroups, allUpcomingGroups]);
  const allPendingGroups = callbackSplit.pending;
```
(replacing the old `const allPendingGroups = groupRows(pending);`). Everything downstream (tab counts, `applyFilter`, the flat view's `combined`, `renderedGroups`) now sees each booking once. After `const pendingGroups = applyFilter(allPendingGroups, type);` add
`const movedCallbacks = applyFilter(callbackSplit.moved, type).length;`.

Pending `Section`: add
```tsx
            description={
              movedCallbacks > 0 ? (
                <>
                  +{movedCallbacks} more with a date — shown under{" "}
                  <a href="#today" className="font-semibold underline">Today</a> /{" "}
                  <a href="#next-30-days" className="font-semibold underline">Next 30 days</a>{" "}
                  with a Callback needed tag.
                </>
              ) : undefined
            }
```
and give the Today / Next 30 days `Section`s `anchor="today"` / `anchor="next-30-days"` (the `anchor` prop already exists — see the no-set-time section).

In `GroupRow`'s scheduled cell (the `r.scheduled_at ? manilaDateTime(…)` branch), render the tag when the lead is a dated callback:
```tsx
        {r.scheduled_at ? (
          <>
            {manilaDateTime(r.scheduled_at)}
            {r.status === "pending_callback" ? (
              <p className="mt-1 inline-block rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Callback needed
              </p>
            ) : null}
          </>
        ) : r.status === "pending_callback" ? (
```
Check `FlatTable`'s row renderer: if it does not reuse `GroupRow`, add the same tag in its scheduled cell.

- [ ] **Step 5: Run tests** — `npx vitest run src/lib/appointments && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/lib/appointments/callback-dedupe.ts src/lib/appointments/callback-dedupe.test.ts "src/app/(staff)/staff/(dashboard)/appointments/page.tsx"
git commit -m "fix(appointments): a dated pending callback shows once, in its date section, tagged"
```

---

### Task 6: Whole-panel selection — keys, member loader, server actions (item 10, part 1)

**Panel rule (owner):** key `panel:<visitId>:<reportGroupId>`; members = every `test_requests` row of that visit whose service's `report_group_id` is the group, `is_package_header = false`, `status in ('requested','in_progress')`, `deleted_at is null` — exactly the bench set the panel's own page works (`queue/consolidated/[visitId]/[groupId]/page.tsx` `encodeRows`). Resolved on the server, never from the page. All-or-nothing per panel: pre-check every member, write with the SAW predicates, and if the write returns fewer rows than members, **compensate** (undo what this call just changed) and report the panel as skipped. One skipped-row entry per panel, keyed by the panel key.

**Files:**
- Modify: `src/lib/queue/bulk-queue.ts`, `src/lib/queue/bulk-queue.test.ts`
- Create: `src/lib/queue/panel-members.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts` (`claimTestsAction`, `unclaimTestsAction`)
- Modify: `src/lib/actions/visits/queue-deletion.ts` (`deleteTestRequestsManyAction`, `deleteTestRequestsForVisit`)

- [ ] **Step 1: Write the failing tests** (append to `bulk-queue.test.ts`)

```ts
import { panelKey, parsePanelKey, splitQueueKeys } from "./bulk-queue";

const V = "11111111-1111-4111-8111-111111111111";
const G = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";

describe("panel keys", () => {
  it("round-trips", () => {
    expect(parsePanelKey(panelKey(V, G))).toEqual({ visitId: V, groupId: G });
  });
  it("rejects anything that is not two uuids", () => {
    expect(parsePanelKey(T)).toBeNull();
    expect(parsePanelKey(`panel:${V}`)).toBeNull();
    expect(parsePanelKey(`panel:${V}:nope`)).toBeNull();
    expect(parsePanelKey(`panel:${V}:${G}:x`)).toBeNull();
  });
  it("splits a selection into single tests and panels", () => {
    expect(splitQueueKeys([T, panelKey(V, G)])).toEqual({
      testIds: [T],
      panels: [{ key: panelKey(V, G), visitId: V, groupId: G }],
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/queue/bulk-queue.test.ts` → FAIL.

- [ ] **Step 3: Implement the pure helpers** (in `bulk-queue.ts`)

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Selection key of a consolidated (chemistry) panel card: the visit + report
 * group, NOT the ids the card shows — the queue pages by test before folding
 * into cards, so a card can hold part of a panel. The server resolves every
 * member (panel-members.ts).
 */
export function panelKey(visitId: string, groupId: string): string {
  return `panel:${visitId}:${groupId}`;
}

export interface PanelRef {
  key: string;
  visitId: string;
  groupId: string;
}

export function parsePanelKey(key: string): { visitId: string; groupId: string } | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== "panel") return null;
  const [, visitId, groupId] = parts as [string, string, string];
  return UUID_RE.test(visitId) && UUID_RE.test(groupId) ? { visitId, groupId } : null;
}

export function splitQueueKeys(keys: readonly string[]): { testIds: string[]; panels: PanelRef[] } {
  const testIds: string[] = [];
  const panels: PanelRef[] = [];
  for (const key of keys) {
    const panel = parsePanelKey(key);
    if (panel) panels.push({ key, ...panel });
    else testIds.push(key);
  }
  return { testIds, panels };
}
```
Also change `BulkQueueResult`'s ok arm to `{ ok: true; changedIds: string[]; skipped: SkippedRow[]; batchId?: string }` and update the doc comment: "ids are SELECTION keys — a test id, or a panel key for a whole panel".

- [ ] **Step 4: Server-only member loader** — `src/lib/queue/panel-members.ts`

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { panelKey, type PanelRef } from "./bulk-queue";

export interface PanelMember {
  id: string;
  visit_id: string;
  status: string;
  assigned_to: string | null;
  started_at: string | null;
  is_package_header: boolean;
  services: { kind: string | null; section: string | null; name: string; report_group_id: string | null };
  visits: { deleted_at: string | null; payment_status: string; hmo_provider_id: string | null };
}

/** Upper bound on member rows one bulk call may touch (MAX_BULK_RECORDS in the kit). */
export { MAX_BULK_RECORDS as MAX_PANEL_MEMBER_ROWS } from "@/lib/ui/bulk-selection";

// Every live bench member of each requested panel — the same set the panel's
// own page claims and unclaims (queue/consolidated/[visitId]/[groupId]/page.tsx:
// not a package header, not cancelled, not deleted, still requested or in
// progress). A panel with no bench members maps to [] (callers report it).
// `services!inner` makes the report_group filter a real filter — PostgREST
// silently ignores a filter on a LEFT-joined embed.
export async function loadPanelMembers(
  supabase: SupabaseClient<Database>,
  panels: readonly PanelRef[],
): Promise<{ ok: true; members: Map<string, PanelMember[]> } | { ok: false; error: string }> {
  const members = new Map<string, PanelMember[]>(panels.map((p) => [p.key, []]));
  if (panels.length === 0) return { ok: true, members };
  const { data, error } = await supabase
    .from("test_requests")
    .select(
      "id, visit_id, status, assigned_to, started_at, is_package_header, services!inner ( kind, section, name, report_group_id ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("visit_id", [...new Set(panels.map((p) => p.visitId))])
    .in("services.report_group_id", [...new Set(panels.map((p) => p.groupId))])
    .eq("is_package_header", false)
    .in("status", ["requested", "in_progress"])
    .is("deleted_at", null)
    .returns<PanelMember[]>();
  if (error) return { ok: false, error: error.message };
  for (const row of data ?? []) {
    const groupId = row.services.report_group_id;
    if (!groupId) continue;
    members.get(panelKey(row.visit_id, groupId))?.push(row);
  }
  return { ok: true, members };
}
```
(If `export { … } from` of a const trips the `server-only` lint, instead import `MAX_BULK_RECORDS` from `@/lib/ui/bulk-selection` directly in the actions.)

- [ ] **Step 5: `claimTestsAction` accepts panels**

New input schema (replace `BulkClaimSchema`):
```ts
const PanelRefSchema = z.object({ visitId: z.string().uuid(), groupId: z.string().uuid() });
const BulkClaimSchema = z
  .object({
    testIds: z.array(z.string().uuid()).max(MAX_BULK_SELECTION),
    panels: z.array(PanelRefSchema).max(MAX_BULK_SELECTION),
  })
  .refine((v) => v.testIds.length + v.panels.length >= 1 && v.testIds.length + v.panels.length <= MAX_BULK_SELECTION);
```
Flow (role check stays first, unchanged):
1. `ids = unique(parsed.testIds)`; `panels = unique-by-key(parsed.panels).map(p => ({ key: panelKey(p.visitId, p.groupId), ...p }))`.
2. `const loaded = await loadPanelMembers(supabase, panels); if (!loaded.ok) return { ok: false, error: translatePgError({ message: loaded.error } as never) }` — simpler: `return { ok: false, error: "Could not load the chemistry panels — try again." }`.
3. Records cap: `ids.length + sum(members.length) > MAX_BULK_RECORDS` → `{ ok: false, error: "Too many tests in one go — select fewer panels." }` (before any write).
4. Existing single-test loop unchanged.
5. Panel loop (after singles), per panel:
```ts
  for (const panel of panels) {
    const list = loaded.members.get(panel.key) ?? [];
    if (list.length === 0) {
      skipped.push({ id: panel.key, reason: "Nothing left to claim in this panel — refresh the queue." });
      continue;
    }
    const refusal = list
      .map((m) =>
        evaluateClaim(
          {
            isPackageHeader: m.is_package_header,
            isDoctorLine: isDoctorKind(m.services.kind),
            section: m.services.section,
            visitDeleted: m.visits.deleted_at !== null,
            visit: m.visits,
          },
          session.role,
        ),
      )
      .find((v) => !v.ok);
    if (refusal && !refusal.ok) {
      skipped.push({ id: panel.key, reason: refusal.error });
      continue;
    }
    if (list.some((m) => m.status !== "requested" || m.assigned_to !== null)) {
      skipped.push({ id: panel.key, reason: "Part of this panel is already claimed — open it to check." });
      continue;
    }
    const memberIds = list.map((m) => m.id);
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
      .in("id", memberIds)
      .eq("status", "requested")
      .is("assigned_to", null)
      .is("deleted_at", null)
      .select("id, visit_id");
    if (error) {
      skipped.push({ id: panel.key, reason: translatePgError(error) });
      continue;
    }
    const got = data ?? [];
    if (got.length !== memberIds.length) {
      // Lost a race on part of the panel: hand back what THIS call just took
      // (matched on our own started_at), so a panel is never left half-claimed.
      if (got.length > 0) {
        await supabase
          .from("test_requests")
          .update({ status: "requested", assigned_to: null, started_at: null })
          .in("id", got.map((r) => r.id))
          .eq("status", "in_progress")
          .eq("assigned_to", session.user_id)
          .eq("started_at", startedAt);
      }
      skipped.push({ id: panel.key, reason: "Part of this panel was claimed or changed just now — refresh the queue." });
      continue;
    }
    changedPanels.push({ key: panel.key, rows: got });
  }
```
6. Audit: singles as today; for each changed panel, one `test_request.claimed` row per member with `metadata: { visit_id, bulk_batch_size, bulk_batch_id, panel_key: panel.key }`. (`bulk_batch_id`/`bulk_batch_size` come from Task 8 — in this task write `bulk_batch_size: totalRecords` where `totalRecords = ids.length + sum(members)`; Task 8 adds the id.)
7. Return `changedIds: [...singleIds, ...changedPanels.map(p => p.key)]`. Revalidate `/staff/queue` and each member's `/staff/queue/<id>` plus `/staff/queue/consolidated/<visitId>/<groupId>`.

- [ ] **Step 6: `unclaimTestsAction` accepts panels**

Schema adds `panels: z.array(PanelRefSchema.extend({ assignedTo: z.string().uuid() })).max(MAX_BULK_SELECTION).default([])`, with the same total-count refine (items + panels between 1 and MAX_BULK_SELECTION). Per panel (after singles), using `loadPanelMembers`:
- `list.length === 0` → skip "Nothing left to unclaim in this panel — refresh the queue."
- any `m.visits.deleted_at !== null` → skip "Deleted from the queue — restore it before unclaiming it."
- any `!evaluateUnclaim(m, ownerId).ok` → skip with `ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN`.
- any `m.assigned_to !== panel.assignedTo` → skip "Someone else holds part of this panel now — refresh the queue."
- write: `update({ status: "requested", assigned_to: null, started_at: null }).in("id", memberIds).eq("status", "in_progress").eq("assigned_to", panel.assignedTo).is("deleted_at", null).select("id, visit_id")`.
- partial → compensate per returned row: `update({ status: "in_progress", assigned_to: panel.assignedTo, started_at: startedAtOf.get(id) ?? null }).eq("id", id).eq("status", "requested").is("assigned_to", null)`; skip "Part of this panel changed just now — refresh the queue."
- audit per member: same shape as the singles (`test_request.unclaimed`, `previous_assignee`, `reason`, `self_service`, `bulk_batch_size`) plus `panel_key` and `previous_started_at: m.started_at` (Task 8 adds `previous_started_at` to the singles too — here, include it already).

- [ ] **Step 7: `deleteTestRequestsManyAction` accepts panels**

Schema: `testRequestIds` becomes `.min(0)`, add `panels: z.array(PanelRefSchema).max(MAX_BULK_SELECTION).default([])`, refine total 1..MAX_BULK_SELECTION (message "Nothing to delete — no tests were selected." for 0). After `parseReason`, `loadPanelMembers(admin, panels)` (admin client — this action already reads with it after the role/shape/reason checks, keep that order). Build per visit `Map<visitId, { ids: string[]; keyOf: Map<testId, selectionKey> }>` from singles (key = id) and panel members (key = panel key); empty panel → skipped "Nothing left to delete in this panel — refresh the queue."; records cap as in Step 5. Call `deleteTestRequestsForVisit(session, visitId, ids, reason, { size, batchId: undefined, panelKeyOf })` — change its last param from `bulkBatchSize?: number` to
```ts
  bulk?: { size: number; batchId?: string; panelKeyOf?: ReadonlyMap<string, string> },
```
and its audit metadata to `...(bulk ? { bulk_batch_size: bulk.size, ...(bulk.batchId ? { bulk_batch_id: bulk.batchId } : {}), ...(bulk.panelKeyOf?.get(row.id) ? { panel_key: bulk.panelKeyOf.get(row.id) } : {}) } : {})`. Map results back to selection keys: a single id is changed if deleted; a panel key is changed only if ALL its members were deleted, otherwise one skipped entry for the panel ("Part of this panel could not be deleted — open it to check." or the visit's `outcome.error`).

- [ ] **Step 8: Run tests, typecheck, lint** — `npx vitest run src/lib/queue && npm run typecheck && npm run lint > tmp/t6-lint.log 2>&1; echo lint $?` → PASS / 0. (Typecheck will flag the bar's old call shapes — fix them minimally in `queue-bulk-bar.tsx`: `claimTestsAction({ testIds: keys, panels: [] })`, `unclaimTestsAction({ items, panels: [], reason })`, `deleteTestRequestsManyAction({ testRequestIds: keys, panels: [], reason })`. Task 7 sends real panels.)

- [ ] **Step 9: Commit**
```bash
git add src/lib/queue src/lib/actions/visits/queue-deletion.ts "src/app/(staff)/staff/(dashboard)/queue"
git commit -m "feat(queue): bulk claim/unclaim/delete accept whole chemistry panels, all-or-nothing"
```

---

### Task 7: Whole-panel selection — page and bar (item 10, part 2)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/page.tsx` (card types ~105, fold ~490, selection ~600–660, grouped card render ~1115)
- Modify: `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx`

- [ ] **Step 1: Card data**

`QueueCardGrouped` gains `sections: string[]` (push `svc.section ?? ""` in both the create and merge branches of the fold, de-duplicated).

- [ ] **Step 2: True membership for the visible panels**

After `matched` is built and `selectable` is known:
```ts
  // Whole-panel selection (owner 2026-09-28): the card may hold only part of
  // its panel (paging happens before the fold), so a panel's checkbox, count
  // and kinds come from ALL its bench members — the same set the server acts
  // on (src/lib/queue/panel-members.ts). A failed read leaves panels without
  // checkboxes (fail closed).
  const panelCards = selectable
    ? matched.filter((c): c is QueueCardGrouped => c.kind === "grouped")
    : [];
  const panelMembers = new Map<string, Array<{ status: string; assigned_to: string | null }>>();
  let panelsReadable = panelCards.length === 0;
  if (panelCards.length > 0) {
    const { data: memberRows, error: memberError } = await supabase
      .from("test_requests")
      .select("id, visit_id, status, assigned_to, services!inner ( report_group_id )")
      .in("visit_id", [...new Set(panelCards.map((c) => c.visitId))])
      .in("services.report_group_id", [...new Set(panelCards.map((c) => c.groupId))])
      .eq("is_package_header", false)
      .in("status", ["requested", "in_progress"])
      .is("deleted_at", null)
      .returns<Array<{ id: string; visit_id: string; status: string; assigned_to: string | null; services: { report_group_id: string | null } }>>();
    panelsReadable = !memberError;
    for (const row of memberRows ?? []) {
      if (!row.services.report_group_id) continue;
      const key = panelKey(row.visit_id, row.services.report_group_id);
      const list = panelMembers.get(key) ?? [];
      list.push({ status: row.status, assigned_to: row.assigned_to });
      panelMembers.set(key, list);
    }
  }
```
(Use the page's existing server `supabase` client variable name.)

- [ ] **Step 3: Panel kinds, entries and labels**

In the selection-building loop, handle grouped cards when `panelsReadable`:
```ts
      if (card.kind === "grouped") {
        const key = panelKey(card.visitId, card.groupId);
        const members = panelMembers.get(key) ?? [];
        if (members.length === 0) continue;
        const holders = new Set(members.map((m) => m.assigned_to));
        const holder = holders.size === 1 ? [...holders][0]! : null;
        const kinds = queueRowKinds({
          claimable:
            members.every((m) => m.status === "requested" && m.assigned_to === null) &&
            card.sections.every((s) => canClaimSection(session.role, s || null)),
          unclaimable:
            members.every((m) => m.status === "in_progress") &&
            holder !== null &&
            (session.role === "admin" || holder === user?.id),
          deletable: card.canDelete,
        });
        if (kinds.length === 0) continue;
        selectionEntries.push({ rowKey: key, kinds, weight: members.length });
        rowsByKey[key] = {
          visitId: card.visitId,
          label: `${card.label.replace(/ \(\d+ tests?\)$/, "")} panel (${members.length} test${members.length === 1 ? "" : "s"}) — ${card.patientName}`,
          assignedTo: holder,
        };
        panelTotals.set(key, members.length);
        continue;
      }
```
(declare `const panelTotals = new Map<string, number>();` next to `rowsByKey`). Check `canClaimSection`'s parameter type and pass `s || null` or `s` accordingly. Delete `const hasPanels = …`.

- [ ] **Step 4: Render the checkbox and the true count on the grouped card**

In the grouped-card row, render the same `RowSelectCheckbox` cell the single rows use, keyed `panelKey(card.visitId, card.groupId)`, when `rowsByKey[thatKey]` exists (otherwise the same empty cell singles get when not selectable — keep the column aligned). Under the card label, when `panelTotals.get(key)! > card.memberIds.length`, add:
```tsx
<p className="text-[11px] text-[color:var(--color-brand-text-soft)]">
  {panelTotals.get(key)} tests in this panel — {panelTotals.get(key)! - card.memberIds.length} on another page. Selecting it acts on all of them.
</p>
```
Update the comment block above `const selectable` (the "Chemistry panel cards get no checkbox" sentence) to describe the whole-panel rule instead. The page's `SelectAllCheckbox` receives `selectionEntries`, which now includes panels.

- [ ] **Step 5: Bar sends panels**

In `queue-bulk-bar.tsx`: remove the `hasPanels` prop and its note (update the page call site). Build requests with `splitQueueKeys`:
```ts
  function claim() {
    if (pending || claimKeys.length === 0) return;
    const keys = claimKeys;
    const { testIds, panels } = splitQueueKeys(keys);
    setRunning("claim");
    start(async () =>
      done("Claimed", keys, await claimTestsAction({ testIds, panels: panels.map(({ visitId, groupId }) => ({ visitId, groupId })) }), false),
    );
  }
```
Unclaim: `items` from the single test keys (as today) and `panels: panels.map(p => ({ visitId: p.visitId, groupId: p.groupId, assignedTo: rowsByKey[p.key]!.assignedTo! }))`. Delete: `{ testRequestIds: testIds, panels: panels.map(({visitId, groupId}) => ({visitId, groupId})), reason }`. The panel text counts ("Put N tests back…") should use records, not rows: use `records` from `useRowSelection()` only for wording where "tests" is meant; simplest correct wording: `n(panelCount)` → replace with `${panelCount} selected row${panelCount === 1 ? "" : "s"}` when any selected key is a panel, else keep `n(panelCount)`.

- [ ] **Step 6: Run tests, typecheck, lint** → PASS / 0.

- [ ] **Step 7: Commit**
```bash
git add "src/app/(staff)/staff/(dashboard)/queue"
git commit -m "feat(queue): chemistry panel cards are selectable as whole panels, true test count shown"
```

---

### Task 8: Batch ids, prior-state audit metadata, pure Undo planner (item 9, part 1)

**Files:**
- Create: `src/lib/ui/bulk-undo.ts`, `src/lib/ui/bulk-undo.test.ts`
- Create: `src/lib/audit/bulk-batch.ts`
- Modify: `appointments/actions.ts` (`ApptResult`, `transitionGroups`, `bulkTransitionAction`, `deleteGroups`, `bulkDeleteAction`, likely-no-show audits), `queue/actions.ts`, `queue-deletion.ts`

- [ ] **Step 1: Write the failing tests** — `src/lib/ui/bulk-undo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  bucketAppointmentUndo,
  groupUndoSteps,
  planAppointmentUndo,
  planQueueUndo,
  undoWindowStartIso,
} from "./bulk-undo";

describe("undo window", () => {
  it("is ten minutes", () => {
    expect(UNDO_WINDOW_MS).toBe(600_000);
    expect(undoWindowStartIso(Date.parse("2026-09-28T10:10:00Z"))).toBe("2026-09-28T10:00:00.000Z");
  });
});

describe("planAppointmentUndo", () => {
  const row = (id: string, action: string, previous: unknown, group?: string[]) => ({
    resource_id: id,
    action,
    metadata: { previous_status: previous, ...(group ? { group_appointment_ids: group } : {}) },
  });
  it("restores each row to the status it had before the bulk action", () => {
    expect(
      planAppointmentUndo([
        row("a", "appointment.cancelled", "arrived", ["a", "b"]),
        row("b", "appointment.cancelled", "arrived", ["a", "b"]),
        row("c", "appointment.confirmed", "pending_callback"),
        row("d", "appointment.no_show", "confirmed"),
      ]),
    ).toEqual([
      { id: "a", current: "cancelled", restoreTo: "arrived", groupIds: ["a", "b"] },
      { id: "b", current: "cancelled", restoreTo: "arrived", groupIds: ["a", "b"] },
      { id: "c", current: "confirmed", restoreTo: "pending_callback", groupIds: ["c"] },
      { id: "d", current: "no_show", restoreTo: "confirmed", groupIds: ["d"] },
    ]);
  });
  it("ignores deletes, unknown statuses, missing previous status and duplicates", () => {
    expect(
      planAppointmentUndo([
        row("a", "appointment.deleted", "confirmed"),
        row("b", "appointment.cancelled", "completed"),
        row("c", "appointment.cancelled", undefined),
        row("d", "appointment.cancelled", "cancelled"),
        row("e", "appointment.no_show", "confirmed"),
        row("e", "appointment.no_show", "confirmed"),
      ]).map((e) => e.id),
    ).toEqual(["e"]);
  });
  it("buckets one write per (current, restoreTo)", () => {
    const buckets = bucketAppointmentUndo(
      planAppointmentUndo([
        row("a", "appointment.cancelled", "arrived"),
        row("b", "appointment.cancelled", "confirmed"),
        row("c", "appointment.cancelled", "arrived"),
      ]),
    );
    expect(buckets).toEqual([
      { current: "cancelled", restoreTo: "arrived", ids: ["a", "c"] },
      { current: "cancelled", restoreTo: "confirmed", ids: ["b"] },
    ]);
  });
});

describe("planQueueUndo", () => {
  const P = "panel:v:g";
  it("maps claim → unclaim, unclaim → reclaim, delete → restore", () => {
    expect(
      planQueueUndo([
        { resource_id: "t1", action: "test_request.claimed", metadata: { visit_id: "v1" } },
        {
          resource_id: "t2",
          action: "test_request.unclaimed",
          metadata: { visit_id: "v1", previous_assignee: "u2", previous_started_at: "2026-09-28T01:00:00Z", panel_key: P },
        },
        { resource_id: "t3", action: "test_request.deleted", metadata: { visit_id: "v3" } },
      ]),
    ).toEqual([
      { kind: "unclaim", id: "t1", visitId: "v1", panelKey: null },
      { kind: "reclaim", id: "t2", visitId: "v1", holder: "u2", startedAt: "2026-09-28T01:00:00Z", panelKey: P },
      { kind: "restore", id: "t3", visitId: "v3", panelKey: null },
    ]);
  });
  it("skips rows it cannot reverse", () => {
    expect(
      planQueueUndo([
        { resource_id: "t1", action: "test_request.unclaimed", metadata: { visit_id: "v1" } },
        { resource_id: "t2", action: "test_request.deleted", metadata: {} },
        { resource_id: null, action: "test_request.claimed", metadata: {} },
        { resource_id: "t4", action: "test_request.restored", metadata: { visit_id: "v" } },
      ]),
    ).toEqual([]);
  });
  it("groups a panel's members under its key, singles alone", () => {
    const steps = planQueueUndo([
      { resource_id: "t1", action: "test_request.claimed", metadata: { visit_id: "v", panel_key: P } },
      { resource_id: "t2", action: "test_request.claimed", metadata: { visit_id: "v", panel_key: P } },
      { resource_id: "t3", action: "test_request.claimed", metadata: { visit_id: "v" } },
    ]);
    expect(groupUndoSteps(steps).map((g) => [g.key, g.steps.map((s) => s.id)])).toEqual([
      [P, ["t1", "t2"]],
      ["t3", ["t3"]],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/ui/bulk-undo.ts`**

```ts
// Undo for bulk actions (owner 2026-09-28): available for 10 minutes, only to
// the staff member who ran the action, and only for rows still in the state
// the action left them. WHAT to restore is read back from the audit rows the
// action wrote (tagged with a per-call `bulk_batch_id`), never taken from the
// browser. Pure planning lives here; the writes live in the server actions.

export const UNDO_WINDOW_MINUTES = 10;
export const UNDO_WINDOW_MS = UNDO_WINDOW_MINUTES * 60_000;
/** metadata.via on every audit row an Undo writes. */
export const BULK_UNDO_VIA = "bulk_undo";

export function undoWindowStartIso(nowMs: number): string {
  return new Date(nowMs - UNDO_WINDOW_MS).toISOString();
}

/** Result of an Undo. Ids are the keys the bar knows: appointment ids, or queue selection keys. */
export type BulkUndoResult =
  | { ok: true; restoredIds: string[]; notRestored: Array<{ id: string; reason: string }> }
  | { ok: false; error: string };

export const UNDO_EXPIRED =
  "Undo is no longer available — it lasts 10 minutes and only for your own bulk changes.";
export const UNDO_ALREADY = "This bulk change was already undone.";

export interface AuditRowForUndo {
  resource_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
}

const APPT_UNDOABLE = new Set(["arrived", "no_show", "cancelled", "confirmed"]);
const APPT_RESTORABLE = new Set(["confirmed", "arrived", "no_show", "cancelled", "pending_callback"]);

export interface AppointmentUndoEntry {
  id: string;
  current: string;
  restoreTo: string;
  groupIds: string[];
}

export function planAppointmentUndo(rows: readonly AuditRowForUndo[]): AppointmentUndoEntry[] {
  const out: AppointmentUndoEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id) || !row.action.startsWith("appointment.")) continue;
    const current = row.action.slice("appointment.".length);
    const restoreTo = row.metadata?.previous_status;
    if (!APPT_UNDOABLE.has(current)) continue;
    if (typeof restoreTo !== "string" || !APPT_RESTORABLE.has(restoreTo) || restoreTo === current) continue;
    const g = row.metadata?.group_appointment_ids;
    const groupIds = Array.isArray(g) && g.every((x) => typeof x === "string") ? (g as string[]) : [id];
    seen.add(id);
    out.push({ id, current, restoreTo, groupIds });
  }
  return out;
}

/** One write per (current, restoreTo): its predicate is `status = current`. First-seen order. */
export function bucketAppointmentUndo(
  entries: readonly AppointmentUndoEntry[],
): Array<{ current: string; restoreTo: string; ids: string[] }> {
  const byKey = new Map<string, { current: string; restoreTo: string; ids: string[] }>();
  for (const e of entries) {
    const key = `${e.current}>${e.restoreTo}`;
    const bucket = byKey.get(key) ?? { current: e.current, restoreTo: e.restoreTo, ids: [] };
    bucket.ids.push(e.id);
    byKey.set(key, bucket);
  }
  return [...byKey.values()];
}

export type QueueUndoStep =
  | { kind: "unclaim"; id: string; visitId: string | null; panelKey: string | null }
  | { kind: "reclaim"; id: string; visitId: string | null; holder: string; startedAt: string | null; panelKey: string | null }
  | { kind: "restore"; id: string; visitId: string; panelKey: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function planQueueUndo(rows: readonly AuditRowForUndo[]): QueueUndoStep[] {
  const out: QueueUndoStep[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id)) continue;
    const m = row.metadata ?? {};
    const visitId = str(m.visit_id);
    const panelKey = str(m.panel_key);
    let step: QueueUndoStep | null = null;
    if (row.action === "test_request.claimed") {
      step = { kind: "unclaim", id, visitId, panelKey };
    } else if (row.action === "test_request.unclaimed") {
      const holder = str(m.previous_assignee);
      if (holder) step = { kind: "reclaim", id, visitId, holder, startedAt: str(m.previous_started_at), panelKey };
    } else if (row.action === "test_request.deleted") {
      if (visitId) step = { kind: "restore", id, visitId, panelKey };
    }
    if (!step) continue;
    seen.add(id);
    out.push(step);
  }
  return out;
}

/** A panel's members travel together (all-or-nothing); every other step alone. First-seen order. */
export function groupUndoSteps(steps: readonly QueueUndoStep[]): Array<{ key: string; steps: QueueUndoStep[] }> {
  const byKey = new Map<string, QueueUndoStep[]>();
  for (const s of steps) {
    const key = s.panelKey ?? s.id;
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  return [...byKey].map(([key, list]) => ({ key, steps: list }));
}
```

- [ ] **Step 4: Server-only batch reader** — `src/lib/audit/bulk-batch.ts`

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { undoWindowStartIso, type AuditRowForUndo } from "@/lib/ui/bulk-undo";

// The caller's OWN audit rows for one bulk call, inside the Undo window.
// Admin client: reception cannot read audit_log under RLS, and the filter on
// actor_id is what scopes this to the caller. The created_at bound rides
// idx_audit_log_created_at, so this stays a tiny range scan.
export async function loadOwnBatchRows(opts: {
  actorId: string;
  batchId: string;
  resourceType: "appointment" | "test_request";
  nowMs: number;
}): Promise<{ ok: true; rows: AuditRowForUndo[]; alreadyUndone: boolean } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const since = undoWindowStartIso(opts.nowMs);
  const [rows, undone] = await Promise.all([
    admin
      .from("audit_log")
      .select("resource_id, action, metadata, created_at")
      .eq("actor_id", opts.actorId)
      .eq("resource_type", opts.resourceType)
      .gte("created_at", since)
      .eq("metadata->>bulk_batch_id", opts.batchId)
      .order("created_at", { ascending: true })
      .limit(1000),
    admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("metadata->>undo_of_batch", opts.batchId),
  ]);
  if (rows.error || undone.error) return { ok: false, error: "Could not read what that bulk change did — try again." };
  return {
    ok: true,
    rows: (rows.data ?? []).map((r) => ({
      resource_id: r.resource_id,
      action: r.action,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    alreadyUndone: (undone.count ?? 0) > 0,
  };
}
```

- [ ] **Step 5: Stamp batch ids and prior state in the bulk writes**

Appointments (`appointments/actions.ts`):
- `ApptResult` ok arm: `{ ok: true; changedIds: string[]; batchId?: string }`.
- `transitionGroups(batch, to, extraMetadata?, batchId?: string)`: build `const fromOf = new Map<string, string>()` from `idsByFrom` (skip the `null` bucket). In the audit metadata add `...(fromOf.has(row.id) ? { previous_status: fromOf.get(row.id) } : {})` and `...(batchId ? { bulk_batch_id: batchId } : {})`. Return `batchId` on the ok results when given.
- `bulkTransitionAction`: `const batchId = crypto.randomUUID();` → `transitionGroups(parsedBatch.data, parsedTo.data, undefined, batchId)`.
- `deleteGroups(batch, batchId?)` / `bulkDeleteAction`: same — metadata gets `bulk_batch_id` (no Undo for appointment deletes; the id powers the audit "Whole batch" link).
- `auditBulk` (likely no-shows): add `bulk_batch_id` param from `markLikelyNoShowsAction` / `undoLikelyNoShowsAction` (`crypto.randomUUID()` per call) — audit filter consistency only; that bar keeps its own Undo.

Queue (`queue/actions.ts`, `queue-deletion.ts`):
- `claimTestsAction`, `unclaimTestsAction`, `deleteTestRequestsManyAction`: `const batchId = crypto.randomUUID();` after validation; every audit row they write gets `bulk_batch_id: batchId`; return `batchId` on ok.
- `unclaimTestsAction` singles: add `started_at` to the pre-read select and `previous_started_at: row.started_at` to each audit row (panels already have it from Task 6).
- `deleteTestRequestsManyAction` passes `batchId` into `deleteTestRequestsForVisit`'s `bulk` arg.

- [ ] **Step 6: Run tests, typecheck, lint** → `npx vitest run src/lib/ui && npm run typecheck && npm run lint …` PASS / 0.

- [ ] **Step 7: Commit**
```bash
git add src/lib/ui/bulk-undo.ts src/lib/ui/bulk-undo.test.ts src/lib/audit/bulk-batch.ts "src/app/(staff)/staff/(dashboard)/appointments/actions.ts" "src/app/(staff)/staff/(dashboard)/queue/actions.ts" src/lib/actions/visits/queue-deletion.ts
git commit -m "feat(bulk): every bulk write records its batch id and prior state for Undo"
```

---

### Task 9: `undoBulkAppointmentsAction` (item 9, part 2)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/actions.ts`

- [ ] **Step 1: Implement** (new export, next to the likely-no-show Undo; reuse `chunk`, `BULK_ID_CHUNK`, `activePatients`, `splitBookingsByActivePatient`, `assertAppointmentsPatientsActive` already imported there)

```ts
// Undo for the appointments bulk bar (owner 2026-09-28): puts every booking
// the caller's bulk action moved back to the status it had before — read
// from that action's own audit rows (bulk_batch_id + previous_status), for 10
// minutes, and only where the booking is still in the status the action left
// it (the write's predicate). Moving a booking back into active work
// (arrived / confirmed / pending callback) needs every linked patient active,
// like ↶ Revert; those bookings are held back and named, the rest proceed.
export async function undoBulkAppointmentsAction(input: unknown): Promise<BulkUndoResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  const parsed = z.object({ batchId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: UNDO_EXPIRED };

  const loaded = await loadOwnBatchRows({
    actorId: session.user_id,
    batchId: parsed.data.batchId,
    resourceType: "appointment",
    nowMs: Date.now(),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.alreadyUndone) return { ok: false, error: UNDO_ALREADY };
  const entries = planAppointmentUndo(loaded.rows);
  if (entries.length === 0) return { ok: false, error: UNDO_EXPIRED };

  const notRestored: Array<{ id: string; reason: string }> = [];
  const admin = createAdminClient();
  const needsActive = entries.filter((e) => e.restoreTo !== "no_show" && e.restoreTo !== "cancelled");
  let heldIds = new Set<string>();
  if (needsActive.length > 0) {
    const ids = [...new Set(needsActive.flatMap((e) => e.groupIds))];
    const patientOf = new Map<string, string | null>();
    for (const part of chunk(ids, BULK_ID_CHUNK)) {
      const { data, error } = await admin.from("appointments").select("id, patient_id").in("id", part);
      if (error) return { ok: false, error: "Could not check the patient records — try again." };
      for (const row of data ?? []) patientOf.set(row.id, row.patient_id);
    }
    const patientIds = [...new Set([...patientOf.values()].filter((p): p is string => p !== null))];
    const activeIds = new Set<string>();
    for (const part of chunk(patientIds, BULK_ID_CHUNK)) {
      const { data, error } = await activePatients(admin.from("patients").select("id")).in("id", part);
      if (error) return { ok: false, error: "Could not check the patient records — try again." };
      for (const row of data ?? []) activeIds.add(row.id);
    }
    const bookings = [...new Map(needsActive.map((e) => [e.groupIds.join(","), e.groupIds])).values()];
    const { heldBack } = splitBookingsByActivePatient(bookings, patientOf, activeIds);
    heldIds = new Set(heldBack.flat());
  }
  for (const e of entries) {
    if (heldIds.has(e.id)) notRestored.push({ id: e.id, reason: "patient record deleted or merged" });
  }
  const toWrite = entries.filter((e) => !heldIds.has(e.id));
  const activeCheckIds = toWrite.filter((e) => e.restoreTo !== "no_show" && e.restoreTo !== "cancelled").map((e) => e.id);
  if (activeCheckIds.length > 0) {
    const active = await assertAppointmentsPatientsActive(admin, activeCheckIds);
    if (!active.ok) return { ok: false, error: active.error };
  }

  const supabase = await createClient();
  const undoBatchId = crypto.randomUUID();
  const moved: Array<{ id: string; patient_id: string | null; current: string; restoreTo: string }> = [];
  let failed = false;
  for (const bucket of bucketAppointmentUndo(toWrite)) {
    for (const part of chunk(bucket.ids, BULK_ID_CHUNK)) {
      const { data, error } = await supabase
        .from("appointments")
        .update({ status: bucket.restoreTo })
        .in("id", part)
        .eq("status", bucket.current)
        .select("id, patient_id");
      if (error) {
        failed = true;
        continue;
      }
      for (const row of data ?? []) moved.push({ ...row, current: bucket.current, restoreTo: bucket.restoreTo });
    }
  }
  const movedIds = new Set(moved.map((m) => m.id));
  for (const e of toWrite) {
    if (!movedIds.has(e.id)) notRestored.push({ id: e.id, reason: "changed again since — refresh to see its status" });
  }

  if (moved.length > 0) {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = h.get("user-agent");
    const groupOf = new Map(entries.map((e) => [e.id, e.groupIds]));
    await Promise.all(
      moved.map((row) =>
        audit({
          actor_id: session.user_id,
          actor_type: "staff",
          patient_id: row.patient_id,
          action: `appointment.${row.restoreTo}`,
          resource_type: "appointment",
          resource_id: row.id,
          metadata: {
            actor_role: session.role,
            group_appointment_ids: groupOf.get(row.id) ?? [row.id],
            previous_status: row.current,
            via: BULK_UNDO_VIA,
            undo_of_batch: parsed.data.batchId,
            bulk_batch_id: undoBatchId,
            bulk_batch_size: moved.length,
          },
          ip_address: ip,
          user_agent: ua,
        }),
      ),
    );
    revalidatePath("/staff/appointments");
  }
  if (failed && moved.length === 0) {
    return { ok: false, error: "Could not undo — refresh the page and check the bookings." };
  }
  return { ok: true, restoredIds: [...movedIds], notRestored };
}
```
Imports to add: `loadOwnBatchRows` from `@/lib/audit/bulk-batch`; `BULK_UNDO_VIA, UNDO_ALREADY, UNDO_EXPIRED, bucketAppointmentUndo, planAppointmentUndo, type BulkUndoResult` from `@/lib/ui/bulk-undo`. `crypto` is the Node global. Note the ordering rule: role → input shape → reads (matches the other actions).

- [ ] **Step 2: Typecheck + lint + test** → PASS / 0.

- [ ] **Step 3: Commit**
```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/actions.ts"
git commit -m "feat(appointments): server-checked 10-minute Undo for bulk transitions"
```

---

### Task 10: `undoBulkQueueAction` + restore core (item 9, part 3)

**Files:**
- Create: `src/lib/actions/visits/queue-restore-core.ts` (server-only)
- Modify: `src/lib/actions/visits/queue-deletion.ts` (`restoreTestRequestsAction` calls the core)
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts` (new export)

- [ ] **Step 1: Extract the restore core**

Move the body of `restoreTestRequestsAction` AFTER its role / reason / count checks (the `assertVisitPatientActive` call, the candidates read, the update, the audit loop and `revalidateQueueSurfaces`) into:
```ts
import "server-only";
// …imports it needs (createAdminClient, audit, translatePgError, ipAndAgent,
// assertVisitPatientActive, revalidateQueueSurfaces — move that helper here too
// if it is private to queue-deletion.ts and import it back there)

export type RestoreOutcome = { ok: true; restoredIds: string[] } | { ok: false; error: string };

/**
 * Restores queue-deleted tests on one visit. Trusts its caller for the
 * session, role and reason (restoreTestRequestsAction; the bulk Undo) — it is
 * NOT a server action. `extraMetadata` rides on every audit row.
 */
export async function restoreTestRequestsForVisit(
  session: StaffSession,
  visitId: string,
  testRequestIds: string[],
  reason: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<RestoreOutcome>
```
Return `{ ok: true, restoredIds: restored.map(r => r.id) }` instead of the count; the action maps it back to `{ ok: true, count: outcome.restoredIds.length }`. Behaviour of `restoreTestRequestsAction` must not change (same errors, same audit metadata when `extraMetadata` is `{}`).

- [ ] **Step 2: Implement `undoBulkQueueAction`** (in `queue/actions.ts`)

```ts
// Undo for the lab queue's bulk bar (owner 2026-09-28): reverses the caller's
// own bulk Claim / Unclaim / Delete for 10 minutes, read back from that
// call's audit rows (bulk_batch_id). Each test is reversed only while it is
// still exactly as the action left it; a chemistry panel reverses all-or-
// nothing (compensating a partial write like claimTestsAction does).
//   claimed   → unclaim  (still in progress, held by the caller, no result yet)
//   unclaimed → reclaim  (still requested and unheld; the old holder is still
//                         an active lab worker allowed that section)
//   deleted   → restore  (restoreTestRequestsForVisit — same rules as Restore)
export async function undoBulkQueueAction(input: unknown): Promise<BulkUndoResult> {
  const session = await requireActiveStaff();
  const parsed = z.object({ batchId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: UNDO_EXPIRED };
  const loaded = await loadOwnBatchRows({
    actorId: session.user_id,
    batchId: parsed.data.batchId,
    resourceType: "test_request",
    nowMs: Date.now(),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.alreadyUndone) return { ok: false, error: UNDO_ALREADY };
  const groups = groupUndoSteps(planQueueUndo(loaded.rows));
  if (groups.length === 0) return { ok: false, error: UNDO_EXPIRED };
  // …per group, below…
}
```
Per group (`key`, `steps` — all steps in a group share a kind, because one batch is one action):
- **Role** per kind: `unclaim`/`reclaim` need `LAB_CAPABLE_ROLES`; `restore` needs reception/admin (the queue-delete roles — import the set or re-check `session.role === "reception" || session.role === "admin"`). Wrong role → notRestored `{ id: key, reason: "Your role can no longer do this." }`.
- **unclaim**: pre-read the ids (`status, assigned_to, deleted_at`); all must be `in_progress`, `assigned_to === session.user_id`, not deleted, else notRestored "claimed work has moved on — a result was uploaded or someone else holds it". Write `update({ status: "requested", assigned_to: null, started_at: null }).in("id", ids).eq("status", "in_progress").eq("assigned_to", session.user_id).is("deleted_at", null).select("id, visit_id")`. Partial on a panel → compensate (`update({ status: "in_progress", assigned_to: session.user_id, started_at: <pre-read started_at per row> })` per returned row, predicated `status = requested`, `assigned_to is null`) and notRestored. Audit per row `test_request.unclaimed` with `{ visit_id, previous_assignee: session.user_id, reason: "Undo of a bulk claim", self_service: true, via: BULK_UNDO_VIA, undo_of_batch, bulk_batch_id: undoBatchId, ...(panel ? { panel_key } : {}) }` — the Remarks column reads it like any unclaim.
- **reclaim**: holder = the steps' `holder` (one holder per panel; singles each their own). Read `staff_profiles` (`id, role, is_active, deleted_at`) for the distinct holders; holder must be active, not deleted, in `LAB_CAPABLE_ROLES`, and `canClaimSection(holder.role, section)` for every test's section (pre-read the tests with `status, assigned_to, deleted_at, services!inner ( section ), visits!inner ( deleted_at )`). Tests must be `requested`, unheld, not deleted, visit not deleted. Write `update({ status: "in_progress", assigned_to: holder, started_at: step.startedAt ?? new Date().toISOString() })` per test (started_at differs per row), predicated `.eq("status", "requested").is("assigned_to", null).is("deleted_at", null)`; for a panel, if any row did not come back, compensate the ones that did (`status requested, assigned_to null, started_at null` where `assigned_to = holder`) and notRestored "part of this panel changed since". Audit per row `test_request.reassigned` `{ visit_id, from: null, to: holder, via: BULK_UNDO_VIA, undo_of_batch, bulk_batch_id: undoBatchId }` — the same action the admin Reassign writes. Reasons: holder unusable → "the person who held it can no longer take this test"; state moved → "someone claimed it since, or it changed".
- **restore**: group the group's steps by `visitId`, call `restoreTestRequestsForVisit(session, visitId, ids, "Undo of a bulk delete", { via: BULK_UNDO_VIA, undo_of_batch: batchId, bulk_batch_id: undoBatchId })`; a panel is restored only if all members come back — when the core restores part of a panel (it restores whatever is still deleted), report notRestored "part of this panel was already restored or changed" (no compensation: restoring is always safe to keep).
- Collect `restoredIds` as the group KEYS (test id or panel key) that fully succeeded; `notRestored` keyed the same. Revalidate `/staff/queue` (+ per-test pages) when anything moved. Return `{ ok: true, restoredIds, notRestored }`.

Imports: `loadOwnBatchRows`, `restoreTestRequestsForVisit`, `BULK_UNDO_VIA, UNDO_ALREADY, UNDO_EXPIRED, groupUndoSteps, planQueueUndo, type BulkUndoResult`.

- [ ] **Step 3: Typecheck + lint + test** → PASS / 0 (the existing `queue-deletion` tests, if any, still pass unchanged).

- [ ] **Step 4: Commit**
```bash
git add src/lib/actions/visits "src/app/(staff)/staff/(dashboard)/queue/actions.ts"
git commit -m "feat(queue): server-checked 10-minute Undo for bulk claim, unclaim and delete"
```

---

### Task 11: ↶ Undo in both bars (item 9, part 4)

**Files:**
- Modify: `src/lib/ui/bulk-undo.ts` (+ test) — `undoOutcomeMessage`
- Modify: `appointments-bulk-bar.tsx`, `queue-bulk-bar.tsx`

- [ ] **Step 1: Failing test** (append to `bulk-undo.test.ts`)

```ts
import { undoOutcomeMessage } from "./bulk-undo";

describe("undoOutcomeMessage", () => {
  it("says what came back and names what did not", () => {
    expect(
      undoOutcomeMessage(
        { one: "booking", many: "bookings" },
        { restored: 2, notRestored: [{ label: "Santos, Maria", reason: "changed again since — refresh to see its status" }] },
      ),
    ).toBe(
      "Undone — 2 bookings are back to what they were.\nNot undone (1):\n• Santos, Maria: changed again since — refresh to see its status",
    );
  });
  it("nothing came back", () => {
    expect(undoOutcomeMessage({ one: "test", many: "tests" }, { restored: 0, notRestored: [] })).toBe("Nothing was undone.");
  });
});
```

- [ ] **Step 2: Implement**
```ts
export function undoOutcomeMessage(
  noun: { one: string; many: string },
  r: { restored: number; notRestored: ReadonlyArray<{ label: string; reason: string }> },
): string {
  const head =
    r.restored === 0
      ? "Nothing was undone."
      : `Undone — ${r.restored} ${r.restored === 1 ? noun.one : noun.many} ${r.restored === 1 ? "is" : "are"} back to what ${r.restored === 1 ? "it was" : "they were"}.`;
  if (r.notRestored.length === 0) return head;
  return [head, `Not undone (${r.notRestored.length}):`, ...r.notRestored.map((l) => `• ${l.label}: ${l.reason}`)].join("\n");
}
```
Run the test → PASS.

- [ ] **Step 3: Appointments bar**

Replace the `outcome` string state with:
```ts
type Outcome = {
  message: string;
  undo: { batchId: string; doneAt: number; labelOf: Record<string, string> } | null;
};
const [outcome, setOutcome] = useState<Outcome | null>(null);
const [undoing, startUndo] = useTransition();
```
On a successful non-delete bulk result with `result.batchId` and `result.changedIds.length > 0`: `undo = { batchId, doneAt: Date.now(), labelOf }` where `labelOf` maps every **appointment id** of the sent bookings to its booking label (snapshot — the page refresh will drop these rows from `groupsByKey`). Delete → `undo: null`.
```ts
  function runUndo(u: NonNullable<Outcome["undo"]>) {
    startUndo(async () => {
      const r = await undoBulkAppointmentsAction({ batchId: u.batchId });
      if (!r.ok) {
        setOutcome({ message: r.error, undo: null });
        return;
      }
      // Name bookings, not appointment rows: collapse ids to their labels.
      const restoredLabels = new Set(r.restoredIds.map((id) => u.labelOf[id] ?? id));
      const notRestored = [...new Map(r.notRestored.map((n) => [u.labelOf[n.id] ?? "A booking", n.reason])).entries()]
        .map(([label, reason]) => ({ label, reason }));
      setOutcome({
        message: undoOutcomeMessage({ one: "booking", many: "bookings" }, { restored: restoredLabels.size, notRestored }),
        undo: null,
      });
      router.refresh();
    });
  }
```
Render: `<BulkOutcomePanel message={outcome.message} undo={outcome.undo ? { doneAt: outcome.undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoing, onUndo: () => runUndo(outcome.undo!) } : null} onDismiss={() => setOutcome(null)} />`.

- [ ] **Step 4: Queue bar** — same shape: `labelOf = Object.fromEntries(keys.map(k => [k, rowsByKey[k]?.label ?? "A test"]))` (keys are selection keys; the server's `restoredIds`/`notRestored` use the same keys), `undoBulkQueueAction`, noun test/tests. Claim, Unclaim and Delete all get Undo.

- [ ] **Step 5: Typecheck + lint + tests** → PASS / 0.

- [ ] **Step 6: Commit**
```bash
git add src/lib/ui/bulk-undo.ts src/lib/ui/bulk-undo.test.ts "src/app/(staff)/staff/(dashboard)/appointments/appointments-bulk-bar.tsx" "src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx"
git commit -m "feat(bulk): Undo button on the appointments and lab-queue outcome panels"
```

---

### Task 12: Audit Log — bulk-actions filter, batch view, "Whole batch" link (item 8)

**Files:**
- Create: `src/lib/audit/bulk-filter.ts`, `src/lib/audit/bulk-filter.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/audit/page.tsx`

- [ ] **Step 1: Failing test**
```ts
import { describe, expect, it } from "vitest";
import { BULK_AUDIT_OR, batchAuditOr, batchIdOf, parseBatchParam } from "./bulk-filter";

const B = "44444444-4444-4444-8444-444444444444";

describe("audit bulk filters", () => {
  it("bulk = batch size > 1, a likely-no-show sweep, or any bar action with a batch id", () => {
    expect(BULK_AUDIT_OR).toBe(
      "metadata->bulk_batch_size.gt.1,metadata->bulk_booking_count.gt.1,metadata->>bulk_batch_id.not.is.null",
    );
  });
  it("a batch view shows the batch and its Undo", () => {
    expect(batchAuditOr(B)).toBe(`metadata->>bulk_batch_id.eq.${B},metadata->>undo_of_batch.eq.${B}`);
  });
  it("only a uuid is accepted as a batch param (it reaches a PostgREST filter)", () => {
    expect(parseBatchParam(B)).toBe(B);
    expect(parseBatchParam(`${B},id.gt.0`)).toBeNull();
    expect(parseBatchParam(undefined)).toBeNull();
  });
  it("reads the batch id off a row's metadata", () => {
    expect(batchIdOf({ bulk_batch_id: B })).toBe(B);
    expect(batchIdOf({ bulk_batch_id: 3 })).toBeNull();
    expect(batchIdOf(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**
```ts
// Filters for the Audit Log page's bulk-action views (bulk-select follow-ups
// item 8). Both strings go straight into a PostgREST `.or()`, so a batch id
// is accepted only as a bare uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BULK_AUDIT_OR =
  "metadata->bulk_batch_size.gt.1,metadata->bulk_booking_count.gt.1,metadata->>bulk_batch_id.not.is.null";

export function parseBatchParam(v: string | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

export function batchAuditOr(batchId: string): string {
  return `metadata->>bulk_batch_id.eq.${batchId},metadata->>undo_of_batch.eq.${batchId}`;
}

export function batchIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).bulk_batch_id;
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}
```
Run → PASS.

- [ ] **Step 3: Page**

- `searchParams` type gains `bulk?: string; batch?: string`. `const bulkOnly = params.bulk === "1"; const batchId = parseBatchParam(params.batch);`
- Query: `if (bulkOnly) query = query.or(BULK_AUDIT_OR); if (batchId) query = query.or(batchAuditOr(batchId));`
- **Verify the jsonb comparison locally before relying on it** (Step 4).
- `baseParams` adds `bulk: bulkOnly ? "1" : null, batch: batchId`. `hasAnyFilter` includes both. The Clear link nulls both. The filter `<form>` carries `<input type="hidden" name="bulk" value="1" />` when `bulkOnly` and `<input type="hidden" name="batch" value={batchId} />` when set (a GET form submits only its fields — same reason the sort/size hidden inputs exist).
- Quick filters nav: before the presets, a chip `Bulk actions` linking to `buildListHref(BASE_PATH, baseParams, { bulk: bulkOnly ? null : "1", page: null })`, `aria-current` when active, same classes as the preset chips, `title="Actions run from a selection bar, and their Undo"`.
- When `batchId` is set, above the table: a `role="status"` sky note "Showing one bulk action and its Undo." with a link "Show all bulk actions" → `{ batch: null, bulk: "1", page: null }`.
- Metadata cell: when `batchIdOf(r.metadata)` → a small link "Whole batch" to `buildListHref(BASE_PATH, baseParams, { batch: id, bulk: null, page: null })` above the JSON.

- [ ] **Step 4: Prove the filters on the local stack**

With the local stack up and some bulk audit rows present (run the fixtures + one bulk action, or Task 16), check the SQL PostgREST generates actually matches:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -At -c "select count(*) from audit_log where (metadata->'bulk_batch_size') > '1'::jsonb or (metadata->'bulk_booking_count') > '1'::jsonb or (metadata->>'bulk_batch_id') is not null"
```
and compare to the count the page shows with `?bulk=1` (browser runner check A1 does this). If PostgREST rejects `metadata->bulk_batch_size.gt.1` or the counts differ, do NOT fall back to `->>` with `gt` (a text compare orders "10" before "2"). Instead use `metadata->>bulk_batch_id.not.is.null,metadata->>bulk.eq.true,metadata->>via.like.bulk_*` (every bar action from this PR carries a batch id; PR 1/2 rows without one still show when they carry `bulk: true` or a bulk `via`), and update the test to match.

- [ ] **Step 5: Typecheck + lint + tests** → PASS / 0.

- [ ] **Step 6: Commit**
```bash
git add src/lib/audit/bulk-filter.ts src/lib/audit/bulk-filter.test.ts "src/app/(staff)/staff/(dashboard)/audit/page.tsx"
git commit -m "feat(audit): Bulk actions filter, one-batch view and Whole batch link"
```

---

### Task 13: Local-only guard + `seed:bulk-fixtures` (item 5)

**Files:**
- Modify: `scripts/lib/env-guard.ts`, `scripts/lib/env-guard.test.ts`
- Create: `scripts/seed/bulk-select-fixtures.sql`, `scripts/seed-bulk-select-fixtures.ts`
- Modify: `package.json`

- [ ] **Step 1: Failing test** (append to `env-guard.test.ts`)
```ts
import { localOnlyProblems } from "./env-guard";

describe("localOnlyProblems", () => {
  it("passes a fully local configuration", () => {
    expect(
      localOnlyProblems(
        { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" },
        { APP_BASE: "http://localhost:3007" },
      ),
    ).toEqual([]);
  });
  it("refuses a remote target even when --prod / SEED_ALLOW_PROD would allow it elsewhere", () => {
    const problems = localOnlyProblems(
      { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SEED_ALLOW_PROD: "1" },
      {},
    );
    expect(problems.join("\n")).toContain("abcdefghijklmnopqrst.supabase.co");
  });
  it("refuses a remote app URL", () => {
    expect(
      localOnlyProblems({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, { APP_BASE: "https://drmed.ph" }).join("\n"),
    ).toContain("drmed.ph");
  });
  it("refuses when nothing is configured", () => {
    expect(localOnlyProblems({}, {})).toEqual(["no database is configured"]);
  });
});
```

- [ ] **Step 2: Implement** (in `env-guard.ts`, after `requireLocalOrExplicitProd`)
```ts
// ---------------------------------------------------------------------------
// Local-only scripts (test fixtures, browser checks)
// ---------------------------------------------------------------------------
//
// Some scripts must NEVER run against a remote database, opt-in or not:
// fixture seeders and browser checks create fake patients, flip a staff
// account's role and run bulk actions. They call requireLocalOrExplicitProd
// first (the convention guard-coverage.test.ts enforces), then refuseNonLocal,
// which ignores --prod / SEED_ALLOW_PROD entirely.

/** Every non-local target (DB env vars plus any extra URLs such as APP_BASE), described. */
export function localOnlyProblems(
  env: ScriptEnv,
  extraUrls: Record<string, string | undefined>,
): string[] {
  const targets = classifyTargets(env);
  if (targets.length === 0) return ["no database is configured"];
  const problems = targets
    .filter((t) => !t.isLocal)
    .map((t) => `${t.varName} → ${t.host ?? "(unparseable)"}`);
  for (const [name, url] of Object.entries(extraUrls)) {
    if (!url) continue;
    const host = hostOf(url);
    if (!isLocalHost(host)) problems.push(`${name} → ${host ?? "(unparseable)"}`);
  }
  return problems;
}

export function refuseNonLocal(
  scriptName: string,
  extraUrls: Record<string, string | undefined> = {},
): void {
  const problems = localOnlyProblems(process.env, extraUrls);
  if (problems.length === 0) return;
  console.error(
    `\n  ${scriptName} is LOCAL-ONLY and refuses to run against:\n${problems.map((p) => `    ${p}`).join("\n")}\n` +
      `  (--prod / ${PROD_OPT_IN_ENV} do not apply to it.)\n`,
  );
  process.exit(1);
}
```
Run the env-guard tests → PASS.

- [ ] **Step 3: Fixture SQL** — `scripts/seed/bulk-select-fixtures.sql`

Re-runnable, local-only fixtures for every bulk-select surface. Everything it owns is marked: services `BSQ-*`, visits `9101`–`9106`, patients with last name `Bsqfixture`, appointments with `notes = 'bsq-fixture'`, website messages with `message like 'bsq-fixture%'`. Patients are never deleted (the 0146–0148 soft-delete guard); they are created once and reused.
```sql
-- Local-only fixtures for the bulk-select browser checks (npm run check:bulk-select).
-- Loaded by scripts/seed-bulk-select-fixtures.ts, which refuses any non-local target.
begin;

-- ---- wipe what a previous run left (never patients) ----
delete from audit_log where resource_type = 'test_request' and resource_id in (
  select tr.id from test_requests tr join visits v on v.id = tr.visit_id
  where v.visit_number in ('9101','9102','9103','9104','9105','9106'));
delete from test_requests where visit_id in (
  select id from visits where visit_number in ('9101','9102','9103','9104','9105','9106'));
delete from visits where visit_number in ('9101','9102','9103','9104','9105','9106');
delete from services where code like 'BSQ-%';
delete from audit_log where resource_type = 'appointment' and resource_id in (
  select id from appointments where notes = 'bsq-fixture');
delete from appointments where notes = 'bsq-fixture';
delete from contact_messages where message like 'bsq-fixture%';

-- ---- patients (created once, reused) ----
insert into patients (first_name, last_name, birthdate, sex, phone)
select f, 'Bsqfixture', date '1990-01-01' + (rn * 40), case when rn % 2 = 0 then 'female' else 'male' end, '0917000000' || rn
from (values ('Alpha',1),('Bravo',2),('Charlie',3),('Delta',4),('Echo',5),('Foxtrot',6)) s(f, rn)
where not exists (select 1 from patients p where p.last_name = 'Bsqfixture' and p.first_name = s.f);

-- ---- services ----
insert into services (code, name, price_php, kind, section) values
  ('BSQ-CBC','BSQ Complete Blood Count',100,'lab_test','hematology'),
  ('BSQ-ESR','BSQ ESR',100,'lab_test','hematology'),
  ('BSQ-UA','BSQ Urinalysis',100,'lab_test','urinalysis'),
  ('BSQ-XR','BSQ Chest X-ray',100,'lab_test','imaging_xray');
insert into services (code, name, price_php, kind, section, report_group_id)
select c, n, 100, 'lab_test', 'chemistry', (select id from report_groups where code = 'CHEMISTRY')
from (values ('BSQ-GLU','BSQ Glucose'), ('BSQ-CHOL','BSQ Cholesterol'), ('BSQ-TRIG','BSQ Triglycerides')) s(c, n);

-- ---- visits: 9101/9102/9105/9106 paid, 9103/9104 unpaid + HMO (lab-gate passes via HMO) ----
with pts as (
  select id, row_number() over (order by first_name) rn from patients where last_name = 'Bsqfixture')
insert into visits (patient_id, visit_number, payment_status, hmo_provider_id, total_php)
select id, (9100 + rn)::text,
       case when rn in (3, 4) then 'unpaid' else 'paid' end,
       case when rn in (3, 4) then (select id from hmo_providers order by name limit 1) end,
       0
from pts;

-- ---- lab queue lines ----
-- 9101: 3 singles (claim/unclaim races); 9102: + x-ray (no medtech checkbox);
-- 9103/9104: cross-visit delete; 9105: a 3-test chemistry panel;
-- 9106: a 2-test chemistry panel + a single (use ?size=… to split a panel across pages).
insert into test_requests (visit_id, service_id, requested_by, final_price_php)
select v.id, s.id, (select id from auth.users where email = 'admin@drmed.ph'), 100
from visits v
join services s on (
     (v.visit_number = '9101' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA'))
  or (v.visit_number = '9102' and s.code in ('BSQ-CBC','BSQ-ESR','BSQ-UA','BSQ-XR'))
  or (v.visit_number = '9103' and s.code in ('BSQ-CBC','BSQ-UA'))
  or (v.visit_number = '9104' and s.code in ('BSQ-ESR'))
  or (v.visit_number = '9105' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-TRIG'))
  or (v.visit_number = '9106' and s.code in ('BSQ-GLU','BSQ-CHOL','BSQ-CBC')));

-- ---- appointments (Manila wall-clock times today / tomorrow) ----
with t as (select date_trunc('day', now() at time zone 'Asia/Manila') as d),
     p as (select id, first_name from patients where last_name = 'Bsqfixture'),
     g as (select gen_random_uuid() as grp)
insert into appointments (patient_id, walk_in_name, walk_in_phone, service_id, scheduled_at, status, notes, booking_group_id, source)
select * from (
  -- item 6: pending callback WITH a date today → must show once, under Today, tagged
  select (select id from p where first_name = 'Alpha'), null::text, null::text,
         (select id from services where code = 'BSQ-CBC'),
         ((select d from t) + interval '10 hours') at time zone 'Asia/Manila', 'pending_callback', 'bsq-fixture', null::uuid, 'website'
  union all -- pending callback without a date → stays in Pending callback
  select null, 'BSQ Callback Undated', '09170000099', null, null, 'pending_callback', 'bsq-fixture', null, 'website'
  union all -- a 2-service booking today (one row in the list, weight 2)
  select (select id from p where first_name = 'Bravo'), null, null, (select id from services where code = 'BSQ-CBC'),
         ((select d from t) + interval '11 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', (select grp from g), 'staff'
  union all
  select (select id from p where first_name = 'Bravo'), null, null, (select id from services where code = 'BSQ-UA'),
         ((select d from t) + interval '11 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', (select grp from g), 'staff'
  union all
  select null, 'BSQ Walk-in Today', '09170000098', null,
         ((select d from t) + interval '14 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', null, 'staff'
  union all
  select (select id from p where first_name = 'Charlie'), null, null, null,
         ((select d from t) + interval '9 hours') at time zone 'Asia/Manila', 'arrived', 'bsq-fixture', null, 'staff'
  union all
  select (select id from p where first_name = 'Delta'), null, null, null,
         ((select d from t) + interval '1 day 10 hours') at time zone 'Asia/Manila', 'confirmed', 'bsq-fixture', null, 'staff'
  union all -- untimed (Bookings with no set time)
  select null, 'BSQ Untimed', '09170000097', null, null, 'confirmed', 'bsq-fixture', null, 'website'
) rows;

-- ---- website messages (PR 3's inbox) ----
insert into contact_messages (name, phone, message, status, kind) values
  ('BSQ Sender One', '09170000011', 'bsq-fixture: price of CBC?', 'new', 'general'),
  ('BSQ Sender Two', '09170000012', 'bsq-fixture: corporate APE for 40 staff', 'new', 'corporate'),
  ('BSQ Sender Three', '09170000013', 'bsq-fixture: thanks!', 'replied', 'general');

commit;
```
Before finalising, check column names/values against `src/types/database.ts` and the migrations (e.g. `patients.sex` allowed values, `appointments.source` allowed values in `src/lib/appointments/source.ts`, whether `phone` has a format check). Fix the SQL to match — do not loosen any constraint. Visits 9103/9104 need an HMO provider to pass the lab gate: if `hmo_providers` is empty locally, the runner must print "run npm run seed:hmo first" and exit 1 (add a `select count(*) from hmo_providers` check before loading).

- [ ] **Step 4: Runner** — `scripts/seed-bulk-select-fixtures.ts`
```ts
/**
 * Local-only fixtures for the bulk-select browser checks.
 *
 *   npm run seed:bulk-fixtures                 # (re)load the fixtures
 *   npm run seed:bulk-fixtures -- --as=medtech # …and make inactive@drmed.ph an active medtech
 *
 * Re-runnable: wipes only its own marked rows first (see the SQL file). Refuses
 * any non-local target — --prod / SEED_ALLOW_PROD do not apply. Run
 * `npm run seed:test` first (it creates admin@ and inactive@).
 */
import "./lib/load-env";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { refuseNonLocal, requireLocalOrExplicitProd } from "./lib/env-guard";

const SCRIPT = "seed:bulk-fixtures";
const ROLES = ["reception", "medtech", "xray_technician", "pathologist", "admin"] as const;

requireLocalOrExplicitProd(SCRIPT, {
  writes: "BSQ fixture patients, visits 9101–9106, appointments and website messages; optionally inactive@drmed.ph's role",
});
refuseNonLocal(SCRIPT);

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL is not set — the local stack's is in .env.development.local.");
  process.exit(1);
}
const asArg = process.argv.find((a) => a.startsWith("--as="))?.slice("--as=".length) ?? null;
if (asArg !== null && !(ROLES as readonly string[]).includes(asArg)) {
  console.error(`--as must be one of: ${ROLES.join(", ")}`);
  process.exit(1);
}

const sql = readFileSync(new URL("./seed/bulk-select-fixtures.sql", import.meta.url), "utf8");
const client = new Client({ connectionString: dbUrl });

async function main() {
  await client.connect();
  try {
    await client.query(sql);
    if (asArg) {
      const r = await client.query(
        "update staff_profiles set is_active = true, role = $1 where id = (select id from auth.users where email = 'inactive@drmed.ph') returning id",
        [asArg],
      );
      if (r.rowCount === 0) throw new Error("inactive@drmed.ph not found — run npm run seed:test first");
      console.log(`inactive@drmed.ph is now an active ${asArg}.`);
    }
    const counts = await client.query(
      `select (select count(*) from visits where visit_number between '9101' and '9106') as visits,
              (select count(*) from test_requests tr join visits v on v.id = tr.visit_id where v.visit_number between '9101' and '9106') as tests,
              (select count(*) from appointments where notes = 'bsq-fixture') as appointments,
              (select count(*) from contact_messages where message like 'bsq-fixture%') as messages`,
    );
    console.log("Bulk-select fixtures loaded:", counts.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```
`package.json` scripts: `"seed:bulk-fixtures": "tsx scripts/seed-bulk-select-fixtures.ts",`. If `import.meta.url` is unavailable under tsx's CJS mode, use `join(__dirname, "seed", "bulk-select-fixtures.sql")` the way other scripts resolve sibling files (grep `readFileSync(` in `scripts/` and match it).

- [ ] **Step 5: Prove it**

Run: `npx vitest run scripts/lib && npm run seed:bulk-fixtures -- --as=medtech`
Expected: guard-coverage + env-guard tests PASS; the runner prints `visits: 6, tests: 16, appointments: 8, messages: 3` (adjust the expectation if you corrected the SQL) and the role line. Run it a second time → same counts (re-runnable). Prove the refusal: `NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co SEED_ALLOW_PROD=1 SEED_SKIP_COUNTDOWN=1 npm run seed:bulk-fixtures; echo exit $?` → the LOCAL-ONLY refusal, exit 1, nothing written.

- [ ] **Step 6: Commit**
```bash
git add scripts/lib/env-guard.ts scripts/lib/env-guard.test.ts scripts/seed/bulk-select-fixtures.sql scripts/seed-bulk-select-fixtures.ts package.json
git commit -m "feat(scripts): local-only seed:bulk-fixtures for the bulk-select checks"
```

---

### Task 14: `check:bulk-select` guarded browser runner (item 4)

**Files:**
- Create: `scripts/browser-check/lib.ts`, `scripts/browser-check/bulk-select.ts`
- Modify: `package.json` (`"check:bulk-select": "tsx scripts/browser-check/bulk-select.ts"`)

- [ ] **Step 1: Helpers** — `scripts/browser-check/lib.ts`
```ts
/**
 * Guarded helpers for signed-in, local, headless-Chrome checks of staff pages.
 * Local-only: refuses any non-local database or APP_BASE (refuseNonLocal).
 * Needs a dev server with the LOCAL env (e.g. `PORT=3007 npm run dev` in a
 * worktree whose .env.local points at 127.0.0.1) and `npm run seed:test`.
 */
import "../lib/load-env";
import { chromium, type Browser, type Page } from "playwright-core";
import { Client } from "pg";
import { refuseNonLocal, requireLocalOrExplicitProd } from "../lib/env-guard";

export const APP_BASE = process.env.APP_BASE ?? "http://localhost:3007";

export interface CheckContext {
  browser: Browser;
  db: Client;
  sql: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  expect: (label: string, ok: boolean, detail?: unknown) => void;
  finish: () => Promise<never>;
}

export async function startCheck(name: string): Promise<CheckContext> {
  requireLocalOrExplicitProd(name, {
    writes: "changes inactive@drmed.ph's role and runs bulk actions on the BSQ fixtures (local stack only)",
  });
  refuseNonLocal(name, { APP_BASE });
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const failures: string[] = [];
  let passed = 0;
  return {
    browser,
    db,
    sql: async (q, params) => (await db.query(q, params as unknown[])).rows,
    expect(label, ok, detail) {
      if (ok) passed += 1;
      else failures.push(label);
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
    },
    async finish() {
      await browser.close();
      await db.end();
      console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
      process.exit(failures.length ? 1 : 0);
    },
  };
}

export async function signIn(
  browser: Browser,
  email: string,
  password: string,
  viewport = { width: 1280, height: 800 },
): Promise<Page & { dialogs: string[] }> {
  const ctx = await browser.newContext({ viewport });
  const page = (await ctx.newPage()) as Page & { dialogs: string[] };
  page.dialogs = [];
  page.on("dialog", async (d) => {
    page.dialogs.push(d.message());
    await d.accept();
  });
  await page.goto(`${APP_BASE}/staff/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  return page;
}

export const BAR = '[aria-label="Selected rows"]';
export const OUTCOME = '[role="status"]:has(button:has-text("Dismiss"))';
export const rowBoxes = (p: Page) => p.locator('tbody input[type="checkbox"]');
export const headerBox = (p: Page) => p.locator('thead input[type="checkbox"]').first();
export async function barText(p: Page): Promise<string | null> {
  const bar = p.locator(BAR);
  return (await bar.count()) ? (await bar.innerText()).replace(/\s+/g, " ") : null;
}
export async function outcomeText(p: Page): Promise<string | null> {
  const o = p.locator(OUTCOME);
  return (await o.count()) ? await o.first().innerText() : null;
}
/** Is `selector` pinned to the viewport bottom (fixed, not sticky)? */
export async function pinnedBottom(p: Page, selector: string) {
  return p.locator(selector).first().evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && getComputedStyle(n).position !== "fixed") n = n.parentElement;
    const r = el.getBoundingClientRect();
    return { fixed: !!n, bottomGap: Math.round(innerHeight - r.bottom) };
  });
}
```

- [ ] **Step 2: The checklist runner** — `scripts/browser-check/bulk-select.ts`

Structure: `const c = await startCheck("check:bulk-select");` → reset: run the fixture SQL (import and reuse the same file: `c.sql(readFileSync(…bulk-select-fixtures.sql))`) and set roles with `c.sql("update staff_profiles set is_active = true, role = $1 where id = (select id from auth.users where email = 'inactive@drmed.ph')", [role])` before each role's section. Accounts: `admin@drmed.ph` / `AdminPass123!`, `inactive@drmed.ph` / `InactivePass123!` (from `scripts/seed-test-users.ts`). Each check calls `c.expect(label, condition, detail)`; end with `await c.finish()`.

Checks (labels are the contract — keep them; each must assert, not just log):

*Fixed bars (item 1)*
- `F1 queue bar is fixed at the viewport bottom` — medtech on `/staff/queue?q=BSQ`, tick one row, `pinnedBottom(page, BAR)` → `fixed && bottomGap <= 16`.
- `F2 visit Tests bar is fixed` — admin on the visit page of `9101` (look up its id with SQL), tick a test's checkbox, `pinnedBottom(page, '[aria-label="Bulk actions"]')`.
- `F3 HMO new-batch footer is fixed` — admin on `/staff/admin/accounting/hmo-claims/batches/new` (pick the first provider link if the route needs one), `pinnedBottom` on the footer Panel (locate by its Save button's closest `div[class*="shadow-lg"]`).
- `F4 no sticky bottom element inside <main>` — evaluate on the queue page: no element under `main` with `position: sticky` and a non-`auto` `bottom`.

*Keyboard (item 7)*
- `K1 Enter on a row checkbox focuses the first bar action` — focus a row checkbox, press Space then Enter, `document.activeElement` is a `button` inside `BAR`.
- `K2 Alt+B jumps from anywhere` — focus the page body/search button, press `Alt+KeyB`, same assertion.
- `K3 Escape in the bar clears and returns focus to the checkbox` — from K2 state press Escape → `BAR` gone and `document.activeElement` is the checkbox that was focused before.
- `K4 Alt+B ignored while typing` — focus `#q`, press `Alt+KeyB` → focus still `#q`.

*Named outcome (item 2)*
- `N1 appointments: every unchanged booking is named` — reception on `/staff/appointments`, tick the two Today confirmed bookings (`BSQ Walk-in Today` and the Bravo 2-service one), change the walk-in to `cancelled` via SQL, press `Mark arrived` → outcome text contains `Marked 1 of 2 bookings arrived.` and `BSQ Walk-in Today: had already changed`.

*Dated callbacks (item 6)*
- `C1 dated pending callback shows once` — reception on `/staff/appointments`: the Alpha callback row appears exactly once, inside the Today section, with text `Callback needed`; the Pending callback heading's description contains `+1 more with a date`; `BSQ Callback Undated` is in Pending callback.

*Panels (item 10)*
- `P1 panel card has a checkbox and the true count` — medtech on `/staff/queue?visit=9105`: a checkbox labelled `Select … panel (3 tests) — …` exists.
- `P2 split panel shows its true count and acts on every member` — make 9106's panel straddle a page deterministically: with `N` = the smallest entry of `PAGE_SIZES` (`src/components/staff/list-pagination.tsx`), SQL-insert `N` filler `BSQ-ESR` lines on visit 9106 and set `requested_at` so the order is GLU (t0) < fillers (t0+1s … t0+Ns) < CHOL (t0+N+1 s). Open `/staff/queue?visit=9106&sort=requested&dir=asc&size=N` (use the page's real sort key / param names — read `ORDER_COLUMN` and `parseSort` in queue/page.tsx). Assert page 1 shows the "on another page" note and a checkbox labelled `… panel (2 tests) …`; tick it, Claim → SQL: GLU **and** CHOL are `in_progress` held by the medtech. (The fixture reset removes the fillers — they sit on visit 9106.)
- `P3 panel claim is all-or-nothing` — reset 9105; SQL-claim ONE 9105 member as admin; medtech ticks the 9105 panel (fresh page load before the SQL change, so the checkbox is offered), Claim → outcome names the panel as not changed; SQL: the other two members are still `requested` and unassigned.

*Undo (item 9)*
- `U1 appointments Cancel → Undo restores prior statuses` — reception ticks the Today arrived (Charlie) + the Delta confirmed booking, Cancel → Undo → SQL statuses back to `arrived` / `confirmed`; audit has rows with `via = 'bulk_undo'`.
- `U2 queue Claim → Undo unclaims` — medtech claims 9101's three singles, Undo → all `requested`, unassigned.
- `U3 queue Unclaim (admin) → Undo hands back to the medtech` — medtech claims 9101 CBC; admin bulk-unclaims it; admin Undo → CBC `in_progress`, `assigned_to` = medtech; audit `test_request.reassigned` with `via = bulk_undo`.
- `U4 queue Delete → Undo restores` — admin deletes 9103 UA via the bar, Undo → `deleted_at is null`.
- `U5 Undo refused after the window` — run a bulk Claim, then SQL-age its audit rows: `update audit_log set created_at = created_at - interval '11 minutes' where metadata->>'bulk_batch_id' = $1` (read the id from the latest `test_request.claimed` row), press Undo → outcome says `Undo is no longer available`; the tests stay claimed.
- `U6 Undo button disappears after a successful Undo` — after U2, the outcome panel has no `↶ Undo` button.
- `U7 every Undo was done by the batch's own actor` — SQL: `select count(*) from audit_log u join audit_log o on o.metadata->>'bulk_batch_id' = u.metadata->>'undo_of_batch' where u.metadata->>'via' = 'bulk_undo' and u.actor_id <> o.actor_id` → 0.

*Audit filter (item 8)*
- `A1 Bulk actions chip filters to bulk rows` — admin `/staff/audit?bulk=1`: the count shown equals the SQL count from Task 12 Step 4.
- `A2 Whole batch link shows one batch and its Undo` — click the first `Whole batch` link → URL has `batch=`; every row's metadata contains that batch id or `undo_of_batch` of it.

*Regression (PR 2 checklist, kept)*
- `R1 selection resets on sort / tab / search` and `R2 390px: no horizontal scroll, bar inside viewport` — port the matching blocks of `tmp/bsq-check.mjs` (sort/tab/search reset; the 390px measurement) as assertions.

Write each check as its own `async function` with a `try/catch` that records a FAIL with the error message, so one broken check never hides the rest.

- [ ] **Step 3: Guard coverage**

Run: `npx vitest run scripts/lib/guard-coverage.test.ts` → PASS (both new runners import `load-env` first and call the guard before building a client).

- [ ] **Step 4: Commit**
```bash
git add scripts/browser-check package.json
git commit -m "feat(scripts): local-only check:bulk-select headless-Chrome checklist"
```

---

### Task 15: Docs — guide-version rule (item 3) and guide content

**Files:**
- Modify: `CLAUDE.md` (the `docs/drmed-user-guide.html` bullet, line ~21; the Key commands table; the feature index rows for bulk selection and scripts)
- Modify: `.claude/skills/drmed-staff-ui/SKILL.md` (git-tracked in this repo — CLAUDE.md: update the matching skill in the same PR)
- Modify: `docs/drmed-user-guide.html` (content only)

- [ ] **Step 1: The rule in CLAUDE.md**

Replace "Update it in the PR that changes a flow it describes." with:
"Update its **content** in the PR that changes a flow it describes, but bump the **version and date** (the header line and this bullet) only at merge time, after merging `main` into the branch — parallel PRs that each bumped it kept colliding (#245 had to go from v2.36 to v2.37 at merge)."
Leave the `v2.37, 28 Sep 2026` text itself unchanged in this PR.

Add to the commands table: `npm run seed:bulk-fixtures [-- --as=<role>]` — "Local-only BSQ fixtures for the bulk-select checks (refuses any remote target, even with --prod)"; `npm run check:bulk-select` — "Signed-in headless-Chrome checklist for every bulk bar (local stack + dev server on :3007; `APP_BASE` to change)". Add a one-line note under the `scripts/` guard section: "Fixture and browser-check scripts also call `refuseNonLocal()` — they must never run remotely, opt-in or not."

- [ ] **Step 2: The rule in the skill**

In `drmed-staff-ui/SKILL.md`, near its user-guide guidance (grep `guide`), add the same two sentences, plus: "Bottom action bars: always `FixedBottomBar` (`src/components/staff/fixed-bottom-bar.tsx`) — `sticky` never pins inside the staff shell; `no-bottom-sticky.test.ts` enforces it."

- [ ] **Step 3: Guide content (no version bump)**

In `docs/drmed-user-guide.html`, update the sections that describe Appointments bulk selection, the lab queue bulk bar, the visit Tests bar and the Audit Log:
- the outcome panel names every booking/test not changed or skipped, and has **↶ Undo** for 10 minutes (who can undo what; appointment Delete has no Undo; Undo only reverses rows still as the action left them);
- **Alt+B** (⌥B on Mac) or **Enter** on a checkbox jumps to the actions; Escape clears and returns;
- chemistry panel cards can be ticked; they act on the whole panel, including tests on another page;
- a pending callback with a date appears under Today / Next 30 days with a **Callback needed** tag;
- Audit Log: **Bulk actions** quick filter, **Whole batch** link.
Match the guide's existing wording style (plain, reception-facing). Do not touch the version/date line.

- [ ] **Step 4: Commit**
```bash
git add CLAUDE.md docs/drmed-user-guide.html .claude/skills/drmed-staff-ui/SKILL.md
git commit -m "docs: guide version bumps at merge time; bulk-select follow-ups in the guide"
```

---

### Task 16: Full verification

- [ ] **Step 1: Static gates**

Run: `npm test > tmp/t16-test.log 2>&1; echo test $?; npm run typecheck > tmp/t16-tc.log 2>&1; echo tc $?; npm run lint > tmp/t16-lint.log 2>&1; echo lint $?`
Expected: all 0. Report the test count from the log tail.

- [ ] **Step 2: Local stack + dev server**

`supabase status` (OrbStack, never Docker Desktop). If the local DB lacks recent migrations (sign-in bounces with `has_profile:false`), ask before any `db reset` — other sessions share this stack. `npm run seed:test`, then `npm run seed:bulk-fixtures -- --as=medtech`. Start the dev server in the background with the local env: `PORT=3007 npm run dev > tmp/dev.log 2>&1` (realtime may be stopped locally — the checks use explicit reloads).

- [ ] **Step 3: Browser checklist**

Run: `npm run check:bulk-select > tmp/t16-browser.log 2>&1; echo exit $?` → exit 0, every label PASS. On a FAIL, debug (superpowers:systematic-debugging) and fix the code, not the check, unless the check is provably wrong. Take at most two screenshots for the PR (desktop queue bar with a panel + outcome with Undo; 390px appointments) into `tmp/`.

- [ ] **Step 4: Stop the dev server** and leave the fixtures in place (they are local-only and re-runnable).

---

## After the plan (orchestrator, not a subagent task)

1. ONE `/codex-review astra high base origin/main` (owner instruction). Fix confirmed findings (Sonnet fixers), re-run Task 16 Step 1 + the affected browser checks. No second Codex pass.
2. Open the PR (no migration; say so), body ends with the Claude Code line. Stop for the owner's merge OK.
3. At merge time only: merge `main` in, bump the guide version/date (the new rule), re-run the static gates.
