# Bulk-select next — Website Messages bulk actions + Undo hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Sonnet for every implementer and reviewer subagent, one task at a time** (owner rule).

**Goal:** Ship the seven approved bulk-select follow-ups from memory `drmed-bulk-row-selection` (#264, 3b16acff): Website Messages bulk actions with 10-minute Undo, all-or-nothing chemistry-panel Undo (migration 0200), Undo for the panel row's own Claim, lifecycle-retry parity, and — once the atomic-release work lands — Undo for the Queue's bulk Release.

**Architecture:** Everything reuses the shared bulk kit (`src/components/staff/row-selection/*`, `src/lib/ui/bulk-selection.ts`, `src/lib/ui/bulk-undo.ts`, `src/lib/audit/bulk-batch.ts`): a server-minted `bulk_batch_id` on every audit row, `loadOwnBatchRows` for the 10-minute same-actor window plus the `changedSince` guard, and exact-predicate reverse writes. The panel Undo paths that still write row by row and compensate (reclaim after a bulk Unclaim, restore after a bulk Delete) move into two all-or-nothing database functions modelled on 0191.

**Tech Stack:** Next.js 16 server actions, Supabase (Postgres 17, PostgREST), zod, Vitest (Node + jsdom), `pg` concurrency runner (tsx), headless-Chrome browser check (`npm run check:bulk-select`).

---

## The PR split (proposed)

| PR | Branch / worktree | Items | Migration | Size |
|---|---|---|---|---|
| **A** | `feat/bulk-select-messages` in `.worktrees/bulk-select-next` (this worktree, off origin/main 3b16acff) | 1 — Website Messages bulk actions + Undo | none | medium |
| **B** | `feat/queue-undo-atomic` in `.worktrees/queue-undo-atomic` (fresh off origin/main when PR A is opened) | 2 — panel reclaim/restore Undo all-or-nothing (0200 + proof); 3 — Undo for the panel row's Claim; 5 — `withLifecycleRetry` on the new Undo writes | **0200**, **P0082** (both claimed with `npm run claim` on 2026-09-30) | large |
| **C** | `feat/queue-release-undo` (fresh, AFTER `feat/atomic-report-release` merges) | 4 — 10-min bulk Undo for the Queue's bulk Release; 6 — distinct refusal when a report-mate was released separately; 7 — end-to-end fake-DB test of `undoReleaseBatchAction` on a combined report | none expected | medium |

**Why C waits (coordination constraint, verified 2026-09-30 15:02 PHT):** another session is actively building `feat/atomic-report-release` (`.worktrees/atomic-report-release`, migration 0198, P0081, uncommitted, files modified minutes ago). It moves release and undo-release into database functions (`release_visit_results` / `undo_visit_release`), **deletes** `src/lib/actions/visits/release-rows.ts` and most of `src/lib/visits/undo-release-scope.ts`, and rewrites `release-reports.ts`, `fake-release-db.ts` and `visits/[id]/actions.ts` (−1290 lines). Items 4, 6 and 7 live in exactly those files. Planning them against today's main would be thrown away and would guarantee a large merge conflict for the other session. PR C's plan is written (writing-plans, same rules) the moment that PR merges; its locked intent is recorded in the "PR C" section at the end so nothing is lost.

**Order:** A → B → C, one task at a time. A and B touch different files except `src/lib/audit/bulk-batch.ts` (A widens one type union) — B starts from main after A merges, or merges main in before its PR.

**Guide version:** bump the version and date only at merge time, after merging main, and re-check all four markers right then: `docs/drmed-user-guide.html` toc tag (`<p class="toc-tag">User guide · v2.NN</p>`, ~line 250), cover Version (`<div><strong>Version</strong>2.NN · …`, ~line 329), footer (`drmed.ph User Guide · v2.NN · …`, ~line 1357) and the CLAUDE.md bullet (line ~21). Parallel PRs keep taking the next number — main was v2.54 when this plan was written. During the build, edit guide **content** only.

**Browser runs:** before every `npm run check:bulk-select`, clear the local login limiter and keep the machine quiet (no vitest or other heavy jobs running in parallel — the check flakes under load):

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "delete from public.rate_limit_attempts where key like 'ip:::1%' or key like '%::1%';"
```

(If `rate_limit_attempts` uses a different key column, read its definition first: `\d public.rate_limit_attempts`. Memory: the `staff_login` limiter is 10/15 min/IP and counts rejected attempts too.)

**Effort:** default effort for everything except **Task B5 (the concurrency proof)** — before dispatching B5, ask the owner to switch the session to `--effort high` (`/effort high`), per their instruction.

---

## File map

### PR A (Website Messages)
- Create `src/lib/contact-messages/status-transitions.ts` — the ONE status matrix (detail page + bulk bar + server).
- Create `src/lib/contact-messages/status-transitions.test.ts`.
- Create `src/lib/contact-messages/bulk-status.ts` — pure: bar plan, write grouping, result type, reasons, Undo planning/bucketing.
- Create `src/lib/contact-messages/bulk-status.test.ts`.
- Modify `src/lib/audit/bulk-batch.ts` — `resourceType` union gains `"contact_message"`.
- Modify `src/app/(staff)/staff/(dashboard)/messages/actions.ts` — `updateMessageStatusManyAction`, `undoMessageStatusManyAction`.
- Create `src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts` — behavioural, against `src/lib/testing/fake-db.ts`.
- Modify `src/app/(staff)/staff/(dashboard)/messages/[id]/message-actions.tsx` — buttons read the matrix.
- Modify `src/app/(staff)/staff/(dashboard)/messages/[id]/message-actions.test.tsx` — matrix-driven buttons.
- Create `src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.tsx`.
- Create `src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.test.tsx` (jsdom).
- Modify `src/app/(staff)/staff/(dashboard)/messages/page.tsx` — checkbox column, select-all, provider, bar.
- Modify `scripts/seed/bulk-select-fixtures.sql` — one booked + one closed BSQ message.
- Modify `scripts/browser-check/bulk-select.ts` — `sectionMessages` (M1–M7).
- Modify `docs/drmed-user-guide.html` §3.11 — one paragraph.

### PR B (Queue Undo hardening)
- Create `supabase/migrations/0200_panel_undo_all_or_nothing.sql` — `reclaim_panel_members`, `restore_panel_members` (P0082).
- Create `supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql`.
- Modify `src/lib/accounting/pg-errors.ts` — P0082.
- Modify `src/types/database.ts` — the two RPC signatures.
- Modify `src/lib/patients/write-guards.test.ts` — `KNOWN_WRITER_RPCS` gains both.
- Modify `src/lib/actions/queue/panel-writes.ts` — `reclaimPanelMembers`, `restorePanelMembers`.
- Create `src/lib/actions/queue/panel-writes.undo.test.ts`.
- Modify `src/app/(staff)/staff/(dashboard)/queue/actions.ts` — `undoBulkQueueAction` panel branches use the helpers; single-row unclaim/reclaim writes wrapped in `withLifecycleRetry`; compensation code removed.
- Modify `src/app/(staff)/staff/(dashboard)/queue/actions.undo-behaviour.test.ts` — RPC-based panel expectations.
- Modify `src/lib/queue/partial-panel.ts` (+ its test) — delete exports that become unused.
- Modify `src/app/(staff)/staff/(dashboard)/appointments/actions.ts` — Undo bucket write in `withLifecycleRetry`.
- Create `scripts/panel-undo-concurrency-proof.ts` + npm script `panel-undo:concurrency-proof`.
- Modify `src/app/(staff)/staff/(dashboard)/queue/panel-actions.ts` — `claimPanelAction` mints a batch id.
- Modify `src/app/(staff)/staff/(dashboard)/queue/claim-button.tsx` — navigate with `?claimed=<batch>&at=<ms>`.
- Create `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/claim-undo-notice.tsx` (+ jsdom test).
- Modify `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx` — render the notice.
- Modify `scripts/browser-check/bulk-select.ts` — PU4–PU7, PC1–PC3.
- Modify `docs/drmed-user-guide.html` (Lab queue Undo paragraph), `CLAUDE.md` (migration ledger note), `.claude/skills/drmed-migrations/SKILL.md` (P-code registry: P0082).

---

# PR A — Website Messages bulk actions (item 1, spec §7)

Spec: `docs/superpowers/specs/2026-09-25-bulk-row-selection-design.md` §7. Design additions approved by the owner in this request: the shared fixed bar, keyboard shortcuts (free with `BulkBar`), the named outcome panel, and a 10-minute Undo with a server batch id.

**Undo semantics (locked here):** Undo puts each message back to the status it had AND restores the `handled_by` / `handled_at` it had before the bulk change (the detail page shows "handled by", so an Undo must not leave the bulk actor's name on a message it no longer handled). To do that exactly, the forward write groups rows by their pre-read `(status, handled_by, handled_at)` and predicates on all three, so a message someone touched between the read and the write is skipped (never overwritten), and the audit row records the exact previous values plus the one `handled_at` stamp the call wrote. Undo predicates on `status = to`, `handled_by = caller`, `handled_at = stamp`, so it only ever reverses THIS batch's write. Any newer audit row on a message (reply, note, kind, another status change) refuses that message via `changedSince` — conservative, same as every other bar.

### Task A1: Status matrix module + detail page reads it

**Files:**
- Create: `src/lib/contact-messages/status-transitions.ts`
- Create: `src/lib/contact-messages/status-transitions.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/messages/[id]/message-actions.tsx:83-121`
- Modify: `src/app/(staff)/staff/(dashboard)/messages/[id]/message-actions.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/lib/contact-messages/status-transitions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  STAFF_STATUS_TARGETS,
  STATUS_TRANSITIONS,
  canTransition,
  transitionTargets,
} from "./status-transitions";
import { CONTACT_MESSAGE_STATUSES } from "./labels";

// Spec §7's matrix — the detail page's buttons, the bulk bar and the bulk
// server action all read this one table, so they cannot drift.
describe("status transitions", () => {
  it("matches the detail page's matrix exactly, in button order", () => {
    expect(STATUS_TRANSITIONS).toEqual({
      new: ["replied", "closed"],
      replied: ["closed", "new"],
      booked: ["closed", "new"],
      closed: ["new"],
    });
  });

  it("covers every stored status", () => {
    for (const s of CONTACT_MESSAGE_STATUSES) expect(STATUS_TRANSITIONS[s]).toBeDefined();
  });

  it("never offers booked as a staff target (only the booking flow sets it)", () => {
    expect(STAFF_STATUS_TARGETS).toEqual(["new", "replied", "closed"]);
    for (const s of CONTACT_MESSAGE_STATUSES) expect(transitionTargets(s)).not.toContain("booked");
  });

  it("canTransition follows the matrix and refuses unknown or same-status moves", () => {
    expect(canTransition("new", "replied")).toBe(true);
    expect(canTransition("booked", "replied")).toBe(false);
    expect(canTransition("closed", "closed")).toBe(false);
    expect(canTransition("closed", "replied")).toBe(false);
    expect(canTransition("bogus", "new")).toBe(false);
  });

  it("transitionTargets of an unknown status is empty", () => {
    expect(transitionTargets("bogus")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './status-transitions'`)

Run: `npx vitest run src/lib/contact-messages/status-transitions.test.ts`

- [ ] **Step 3: Implement** — `src/lib/contact-messages/status-transitions.ts`

```ts
// Website Messages — which status a staff member may move a message to,
// from each status. ONE table for the detail page's buttons
// (messages/[id]/message-actions.tsx), the inbox bulk bar and the bulk server
// action (spec 2026-09-25 §7), so the three can never drift. `booked` is set
// only by the booking flow (linkMessageToBooking), never by a staff button.
import { isContactMessageStatus, type ContactMessageStatus } from "./labels";

export const STAFF_STATUS_TARGETS = ["new", "replied", "closed"] as const;
export type StaffStatusTarget = (typeof STAFF_STATUS_TARGETS)[number];

/** Button order is the order here (the detail page renders it as-is). */
export const STATUS_TRANSITIONS: Readonly<Record<ContactMessageStatus, readonly StaffStatusTarget[]>> = {
  new: ["replied", "closed"],
  replied: ["closed", "new"],
  booked: ["closed", "new"],
  closed: ["new"],
};

export function transitionTargets(from: string): readonly StaffStatusTarget[] {
  return isContactMessageStatus(from) ? STATUS_TRANSITIONS[from] : [];
}

export function canTransition(from: string, to: StaffStatusTarget): boolean {
  return transitionTargets(from).includes(to);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/lib/contact-messages/status-transitions.test.ts`

- [ ] **Step 5: Add matrix tests to the detail panel** — append to `message-actions.test.tsx` (change the `render` helper to take a status):

```tsx
function renderStatus(status: "new" | "replied" | "booked" | "closed") {
  return renderToStaticMarkup(
    <MessageActionsPanel
      messageId="msg-1"
      status={status}
      kind="general"
      staffNotes=""
      firstName="Ana"
      hasLinkedAppointment={false}
      canQuote={false}
    />,
  );
}

// The status buttons come from STATUS_TRANSITIONS — same labels and order as
// before the matrix existed (Mark replied / Mark closed / Reopen).
describe("status buttons follow the shared matrix", () => {
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((t) =>
      ["Mark replied", "Mark closed", "Reopen"].includes(t!),
    );
  it.each([
    ["new", ["Mark replied", "Mark closed"]],
    ["replied", ["Mark closed", "Reopen"]],
    ["booked", ["Mark closed", "Reopen"]],
    ["closed", ["Reopen"]],
  ] as const)("%s → %j", (status, want) => {
    expect(buttons(renderStatus(status))).toEqual(want);
  });
});
```

- [ ] **Step 6: Run — expect PASS already** (the old hand-written buttons match). This pins behaviour before the refactor.

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/messages/[id]/message-actions.test.tsx"`

- [ ] **Step 7: Refactor the panel to read the matrix** — in `message-actions.tsx`, import `transitionTargets, type StaffStatusTarget` from `@/lib/contact-messages/status-transitions`, change `fireStatus(target: "new" | "replied" | "closed")` to `fireStatus(target: StaffStatusTarget)`, and replace the four `{status === … ? (…) : null}` blocks (lines 84–120) with:

```tsx
      <div className="flex flex-wrap gap-2">
        {transitionTargets(status).map((target) => (
          <Button
            key={target}
            type="button"
            size="sm"
            variant={target === "replied" ? "success" : "outline"}
            disabled={statusPending}
            onClick={() => fireStatus(target)}
          >
            {target === "replied" && statusPending ? "…" : TARGET_BUTTON_LABEL[target]}
          </Button>
        ))}
      </div>
```

and add above the component:

```tsx
// Button text per target — "new" is "Reopen" from every status that offers it.
const TARGET_BUTTON_LABEL: Record<StaffStatusTarget, string> = {
  replied: "Mark replied",
  closed: "Mark closed",
  new: "Reopen",
};
```

Also in `messages/actions.ts`, replace the local `STATUS_TARGETS` const and `StatusTarget` type with imports of `STAFF_STATUS_TARGETS` / `StaffStatusTarget` from the new module (`z.enum(STAFF_STATUS_TARGETS)`), and update the comment above it to point at the module.

- [ ] **Step 8: Run both test files + typecheck — expect PASS**

Run: `npx vitest run src/lib/contact-messages "src/app/(staff)/staff/(dashboard)/messages" && npm run -s typecheck`

- [ ] **Step 9: Commit**

```bash
git add src/lib/contact-messages/status-transitions.ts src/lib/contact-messages/status-transitions.test.ts "src/app/(staff)/staff/(dashboard)/messages"
git commit -m "refactor(messages): one status-transition matrix for the detail page and the coming bulk bar"
```

### Task A2: Pure bulk helpers (plan, write grouping, Undo planning)

**Files:**
- Create: `src/lib/contact-messages/bulk-status.ts`
- Create: `src/lib/contact-messages/bulk-status.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/contact-messages/bulk-status.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  MESSAGE_BULK_BUTTONS,
  bucketMessageUndo,
  bulkMessagePlan,
  groupMessagesForWrite,
  notAllowedReason,
  planMessageUndo,
} from "./bulk-status";

describe("bulkMessagePlan", () => {
  it("offers each target only the rows the matrix allows, in selection order", () => {
    const plan = bulkMessagePlan([
      { key: "a", status: "new" },
      { key: "b", status: "booked" },
      { key: "c", status: "closed" },
      { key: "d", status: "replied" },
      { key: "e", status: "bogus" },
    ]);
    expect(plan).toEqual({ replied: ["a"], closed: ["a", "b", "d"], new: ["b", "c", "d"] });
  });

  it("buttons are Mark replied, Mark closed, Reopen", () => {
    expect(MESSAGE_BULK_BUTTONS.map((b) => [b.to, b.label])).toEqual([
      ["replied", "Mark replied"],
      ["closed", "Mark closed"],
      ["new", "Reopen"],
    ]);
  });
});

describe("notAllowedReason", () => {
  it("names both statuses in plain words", () => {
    expect(notAllowedReason("booked", "replied")).toBe("a Booked message can't be moved to Replied");
  });
});

describe("groupMessagesForWrite", () => {
  it("groups by the exact (status, handled_by, handled_at) the write will predicate on", () => {
    const groups = groupMessagesForWrite([
      { id: "1", from: "new", handled_by: null, handled_at: null },
      { id: "2", from: "new", handled_by: null, handled_at: null },
      { id: "3", from: "replied", handled_by: "u1", handled_at: "2026-09-30T01:00:00+00:00" },
      { id: "4", from: "replied", handled_by: "u1", handled_at: "2026-09-30T02:00:00+00:00" },
    ]);
    expect(groups).toEqual([
      { from: "new", handledBy: null, handledAt: null, ids: ["1", "2"] },
      { from: "replied", handledBy: "u1", handledAt: "2026-09-30T01:00:00+00:00", ids: ["3"] },
      { from: "replied", handledBy: "u1", handledAt: "2026-09-30T02:00:00+00:00", ids: ["4"] },
    ]);
  });
});

const STAMP = "2026-09-30T03:00:00.000Z";
const row = (id: string, m: Record<string, unknown>, action = "contact_message.status_changed") => ({
  resource_id: id,
  action,
  metadata: { bulk_batch_id: "b", ...m },
});

describe("planMessageUndo", () => {
  it("reads current/restore/previous handler and the stamp from each bulk audit row", () => {
    expect(
      planMessageUndo([
        row("1", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("2", { from: "booked", to: "new", previous_handled_by: "u9", previous_handled_at: "2026-09-29T00:00:00+00:00", handled_at: STAMP }),
      ]),
    ).toEqual([
      { id: "1", current: "closed", restoreTo: "new", previousHandledBy: null, previousHandledAt: null, stamp: STAMP },
      { id: "2", current: "new", restoreTo: "booked", previousHandledBy: "u9", previousHandledAt: "2026-09-29T00:00:00+00:00", stamp: STAMP },
    ]);
  });

  it("skips rows that cannot be reversed exactly", () => {
    expect(
      planMessageUndo([
        row("1", { from: "new", to: "closed", previous_handled_by: null, handled_at: STAMP }), // no previous_handled_at key
        row("2", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null }), // no stamp
        row("3", { from: "closed", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("4", { from: "new", to: "booked", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("5", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }, "contact_message.notes_updated"),
        { resource_id: null, action: "contact_message.status_changed", metadata: {} },
      ]),
    ).toEqual([]);
  });

  it("keeps the first row per message", () => {
    const plan = planMessageUndo([
      row("1", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
      row("1", { from: "replied", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
    ]);
    expect(plan.map((e) => e.restoreTo)).toEqual(["new"]);
  });
});

describe("bucketMessageUndo", () => {
  it("one write per exact (current, restoreTo, previous handler, stamp)", () => {
    const e = (id: string, restoreTo: "new" | "replied", by: string | null) => ({
      id, current: "closed" as const, restoreTo, previousHandledBy: by, previousHandledAt: by ? "2026-09-29T00:00:00+00:00" : null, stamp: STAMP,
    });
    expect(bucketMessageUndo([e("1", "new", null), e("2", "new", null), e("3", "replied", "u1")]).map((b) => b.ids)).toEqual([
      ["1", "2"],
      ["3"],
    ]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run src/lib/contact-messages/bulk-status.test.ts`

- [ ] **Step 3: Implement** — `src/lib/contact-messages/bulk-status.ts`

```ts
// Website Messages bulk bar (spec 2026-09-25 §7) — the pure half: which rows
// each button may send, how the server groups its guarded writes, the
// result shape, and how an Undo plans its reverse writes from the audit rows
// the bulk call wrote. Server code lives in messages/actions.ts; this module
// is imported by both sides (a "use server" file may export only async
// functions, so the shared types and constants live here).
import { CONTACT_MESSAGE_STATUS_LABEL, isContactMessageStatus, type ContactMessageStatus } from "./labels";
import { STAFF_STATUS_TARGETS, canTransition, type StaffStatusTarget } from "./status-transitions";
import type { AuditRowForUndo } from "@/lib/ui/bulk-undo";

export const MESSAGE_BULK_BUTTONS: ReadonlyArray<{
  to: StaffStatusTarget;
  label: string;
  /** formatBulkOutcome's verb + tail: "Marked 3 messages replied." / "Reopened 2 messages." */
  verb: string;
  tail: string;
  variant: "success" | "outline";
}> = [
  { to: "replied", label: "Mark replied", verb: "Marked", tail: "replied", variant: "success" },
  { to: "closed", label: "Mark closed", verb: "Marked", tail: "closed", variant: "outline" },
  { to: "new", label: "Reopen", verb: "Reopened", tail: "", variant: "outline" },
];

export function bulkMessagePlan(
  selected: ReadonlyArray<{ key: string; status: string }>,
): Record<StaffStatusTarget, string[]> {
  const plan: Record<StaffStatusTarget, string[]> = { new: [], replied: [], closed: [] };
  for (const s of selected) {
    for (const to of STAFF_STATUS_TARGETS) if (canTransition(s.status, to)) plan[to].push(s.key);
  }
  return plan;
}

export type BulkMessageResult =
  | { ok: true; changedIds: string[]; skipped: Array<{ id: string; reason: string }>; batchId?: string }
  | { ok: false; error: string };

export const MESSAGE_CHANGED_REASON = "changed since you selected it — refresh to see its status";
export const MESSAGE_GONE_REASON = "no longer exists";
export const MESSAGE_WRITE_FAILED_REASON = "could not be updated just now — try again";

const labelOf = (s: string) => (isContactMessageStatus(s) ? CONTACT_MESSAGE_STATUS_LABEL[s] : s);

export function notAllowedReason(from: string, to: StaffStatusTarget): string {
  return `a ${labelOf(from)} message can't be moved to ${labelOf(to)}`;
}

export interface MessageWriteRow {
  id: string;
  from: ContactMessageStatus;
  handled_by: string | null;
  handled_at: string | null;
}

/** One guarded UPDATE per exact (status, handled_by, handled_at) the server read. First-seen order. */
export function groupMessagesForWrite(
  rows: readonly MessageWriteRow[],
): Array<{ from: ContactMessageStatus; handledBy: string | null; handledAt: string | null; ids: string[] }> {
  const byKey = new Map<string, { from: ContactMessageStatus; handledBy: string | null; handledAt: string | null; ids: string[] }>();
  for (const r of rows) {
    const key = JSON.stringify([r.from, r.handled_by, r.handled_at]);
    const g = byKey.get(key) ?? { from: r.from, handledBy: r.handled_by, handledAt: r.handled_at, ids: [] };
    g.ids.push(r.id);
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

export interface MessageUndoEntry {
  id: string;
  /** The status the bulk call moved the message TO (the Undo write's predicate). */
  current: StaffStatusTarget;
  /** The status it had before (any stored status — booked included). */
  restoreTo: ContactMessageStatus;
  previousHandledBy: string | null;
  previousHandledAt: string | null;
  /** The exact handled_at the bulk call stamped (the Undo write's predicate). */
  stamp: string;
}

const nullableString = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

export function planMessageUndo(rows: readonly AuditRowForUndo[]): MessageUndoEntry[] {
  const out: MessageUndoEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id) || row.action !== "contact_message.status_changed") continue;
    const m = row.metadata ?? {};
    const from = m.from;
    const to = m.to;
    const stamp = m.handled_at;
    if (!("previous_handled_by" in m) || !("previous_handled_at" in m)) continue;
    const previousHandledBy = nullableString(m.previous_handled_by);
    const previousHandledAt = nullableString(m.previous_handled_at);
    if (previousHandledBy === undefined || previousHandledAt === undefined) continue;
    if (typeof stamp !== "string" || stamp.length === 0) continue;
    if (typeof from !== "string" || !isContactMessageStatus(from)) continue;
    if (typeof to !== "string" || !(STAFF_STATUS_TARGETS as readonly string[]).includes(to) || to === from) continue;
    seen.add(id);
    out.push({ id, current: to as StaffStatusTarget, restoreTo: from, previousHandledBy, previousHandledAt, stamp });
  }
  return out;
}

export function bucketMessageUndo(
  entries: readonly MessageUndoEntry[],
): Array<Omit<MessageUndoEntry, "id"> & { ids: string[] }> {
  const byKey = new Map<string, Omit<MessageUndoEntry, "id"> & { ids: string[] }>();
  for (const e of entries) {
    const key = JSON.stringify([e.current, e.restoreTo, e.previousHandledBy, e.previousHandledAt, e.stamp]);
    const { id, ...rest } = e;
    const b = byKey.get(key) ?? { ...rest, ids: [] };
    b.ids.push(id);
    byKey.set(key, b);
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/lib/contact-messages/bulk-status.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/contact-messages/bulk-status.ts src/lib/contact-messages/bulk-status.test.ts
git commit -m "feat(messages): pure bulk plan, guarded write grouping and Undo planning for the inbox bar"
```

### Task A3: `updateMessageStatusManyAction` (forward bulk write)

**Files:**
- Modify: `src/lib/audit/bulk-batch.ts:23` (resourceType union)
- Modify: `src/app/(staff)/staff/(dashboard)/messages/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts`

- [ ] **Step 1: Write the failing behavioural test** — `actions.bulk.test.ts`. Read `src/lib/testing/fake-db.ts` (seed / rows / row / updates / hooks.beforeWrite) and the mock block of `queue/actions.undo-behaviour.test.ts` first; mirror them.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// updateMessageStatusManyAction / undoMessageStatusManyAction end to end
// against the in-memory fake client: the real zod parsing, matrix check,
// guarded writes and Undo planning run; only the session, audit writer,
// headers and cache are stubbed. A predicate dropped from a write changes
// the rows these tests read back.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "11111111-1111-4111-8111-111111111111", role: "reception" } as { user_id: string; role: string },
  db: null as unknown,
  audit: vi.fn(async (entry: Record<string, unknown>) => void entry),
}));
vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));

import { revalidatePath } from "next/cache";
import { updateMessageStatusManyAction } from "./actions";
import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { MESSAGE_CHANGED_REASON, MESSAGE_GONE_REASON } from "@/lib/contact-messages/bulk-status";

const ME = h.session.user_id;
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const msg = (n: number, over: Row = {}): Row => ({
  id: id(n), status: "new", handled_by: null, handled_at: null, kind: "general", ...over,
});
let db: FakeDb;
const audits = () => h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>;

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.session = { user_id: ME, role: "reception" };
  h.audit.mockClear();
  vi.mocked(revalidatePath).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("updateMessageStatusManyAction", () => {
  it("refuses a role outside reception/admin before reading anything", async () => {
    h.session = { user_id: ME, role: "medtech" };
    const r = await updateMessageStatusManyAction({ entries: [], to: "closed" });
    expect(r).toEqual({ ok: false, error: "Only reception or admin can manage website messages." });
    expect(db.calls).toEqual([]);
  });

  it("refuses an empty, oversize or malformed batch", async () => {
    for (const input of [
      { entries: [], to: "closed" },
      { entries: Array.from({ length: 101 }, (_, i) => ({ id: id(i + 1), from: "new" })), to: "closed" },
      { entries: [{ id: id(1), from: "new" }], to: "booked" },
      { entries: [{ id: "not-a-uuid", from: "new" }], to: "closed" },
    ]) {
      const r = await updateMessageStatusManyAction(input);
      expect(r.ok).toBe(false);
    }
    expect(db.updates("contact_messages")).toEqual([]);
  });

  it("moves every eligible message, stamps handled_by/at, audits each with the batch and prior handler", async () => {
    db.seed("contact_messages", [
      msg(1),
      msg(2, { status: "replied", handled_by: OTHER, handled_at: "2026-09-29T01:00:00+00:00" }),
    ]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "replied" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds.sort()).toEqual([id(1), id(2)]);
    expect(r.skipped).toEqual([]);
    expect(r.batchId).toMatch(/^[0-9a-f-]{36}$/);
    for (const n of [1, 2]) {
      expect(db.row("contact_messages", id(n))).toMatchObject({ status: "closed", handled_by: ME });
    }
    const stamp = db.row("contact_messages", id(1)).handled_at;
    expect(db.row("contact_messages", id(2)).handled_at).toBe(stamp);
    const a2 = audits().find((a) => a.resource_id === id(2))!;
    expect(a2.action).toBe("contact_message.status_changed");
    expect(meta(a2)).toMatchObject({
      from: "replied", to: "closed", previous_handled_by: OTHER, previous_handled_at: "2026-09-29T01:00:00+00:00",
      handled_at: stamp, bulk_batch_id: r.batchId, bulk_batch_size: 2,
    });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["/staff/messages", `/staff/messages/${id(1)}`, `/staff/messages/${id(2)}`, "/staff"]),
    );
  });

  it("skips a message whose status changed since selection — never overwrites it", async () => {
    db.seed("contact_messages", [msg(1, { status: "booked" }), msg(2)]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "replied",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_CHANGED_REASON }]);
    expect(db.row("contact_messages", id(1)).status).toBe("booked");
    expect(audits().map((a) => a.resource_id)).toEqual([id(2)]);
  });

  it("a race between the read and the write (handler changed) is skipped by the write's own predicate", async () => {
    db.seed("contact_messages", [msg(1), msg(2)]);
    db.hooks.beforeWrite = (call, d) => {
      if (call.table !== "contact_messages") return;
      const r = d.row("contact_messages", id(1));
      r.handled_by = OTHER; // someone else touched it in between
      r.handled_at = "2026-09-30T00:00:00+00:00";
    };
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_CHANGED_REASON }]);
    expect(db.row("contact_messages", id(1))).toMatchObject({ status: "new", handled_by: OTHER });
  });

  it("names a message the matrix does not allow, and a missing one", async () => {
    db.seed("contact_messages", [msg(1, { status: "booked" })]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "booked" }, { id: id(3), from: "new" }],
      to: "replied",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([]);
    expect(r.skipped).toEqual([
      { id: id(1), reason: "a Booked message can't be moved to Replied" },
      { id: id(3), reason: MESSAGE_GONE_REASON },
    ]);
    expect(r.batchId).toBeUndefined();
  });

  it("a failed write reports the error when nothing changed", async () => {
    db.seed("contact_messages", [msg(1)]);
    db.hooks.beforeWrite = (call) => (call.table === "contact_messages" ? { code: "XX000", message: "boom" } : undefined);
    const r = await updateMessageStatusManyAction({ entries: [{ id: id(1), from: "new" }], to: "closed" });
    expect(r.ok).toBe(false);
    expect(audits()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`updateMessageStatusManyAction` is not exported)

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts"`

- [ ] **Step 3: Widen the batch reader's type** — `src/lib/audit/bulk-batch.ts`, in `loadOwnBatchRows`'s options:

```ts
  resourceType: "appointment" | "test_request" | "historic_hmo_claim" | "contact_message";
```

- [ ] **Step 4: Implement the action** — in `messages/actions.ts` add imports:

```ts
import { MAX_BULK_ROWS } from "@/lib/ui/bulk-selection";
import { CONTACT_MESSAGE_STATUSES, type ContactMessageStatus } from "@/lib/contact-messages/labels"; // merge into the existing labels import
import { STAFF_STATUS_TARGETS, canTransition } from "@/lib/contact-messages/status-transitions";
import {
  MESSAGE_CHANGED_REASON,
  MESSAGE_GONE_REASON,
  MESSAGE_WRITE_FAILED_REASON,
  groupMessagesForWrite,
  notAllowedReason,
  type BulkMessageResult,
  type MessageWriteRow,
} from "@/lib/contact-messages/bulk-status";
```

then, after `updateMessageStatusAction`:

```ts
const BulkStatusSchema = z.object({
  entries: z
    .array(z.object({ id: z.string().uuid(), from: z.enum(CONTACT_MESSAGE_STATUSES) }))
    .min(1)
    .max(MAX_BULK_ROWS),
  to: z.enum(STAFF_STATUS_TARGETS),
});
const BULK_INPUT_ERROR = "Could not read the selection — refresh the inbox and try again.";

/**
 * The inbox bulk bar (spec 2026-09-25 §7). Each entry carries the status the
 * operator SAW; the server re-reads each message and writes one guarded
 * UPDATE per exact (status, handled_by, handled_at) it read, so a message
 * changed by anyone since — status or handler — is skipped and named, never
 * overwritten (the single action above reads then writes by id alone). The
 * same three columns as the single action change; every changed message gets
 * its own audit row carrying the batch id, the handler it had before and the
 * one handled_at this call stamped — exactly what the 10-minute Undo needs.
 */
export async function updateMessageStatusManyAction(input: unknown): Promise<BulkMessageResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = BulkStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const { to } = parsed.data;

  // First occurrence of an id wins.
  const fromOf = new Map<string, ContactMessageStatus>();
  for (const e of parsed.data.entries) if (!fromOf.has(e.id)) fromOf.set(e.id, e.from);
  const ids = [...fromOf.keys()];

  const skipped: Array<{ id: string; reason: string }> = [];
  const candidates = ids.filter((id) => {
    const from = fromOf.get(id)!;
    if (canTransition(from, to)) return true;
    skipped.push({ id, reason: notAllowedReason(from, to) });
    return false;
  });

  const supabase = await createClient();
  const current = new Map<string, { status: string; handled_by: string | null; handled_at: string | null }>();
  if (candidates.length > 0) {
    const { data, error } = await supabase
      .from("contact_messages")
      .select("id, status, handled_by, handled_at")
      .in("id", candidates);
    if (error) return { ok: false, error: translatePgError(error) };
    for (const r of data ?? []) current.set(r.id, r);
  }

  const writable: MessageWriteRow[] = [];
  for (const id of candidates) {
    const row = current.get(id);
    if (!row) skipped.push({ id, reason: MESSAGE_GONE_REASON });
    else if (row.status !== fromOf.get(id)) skipped.push({ id, reason: MESSAGE_CHANGED_REASON });
    else writable.push({ id, from: fromOf.get(id)!, handled_by: row.handled_by, handled_at: row.handled_at });
  }

  const batchId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const changed: MessageWriteRow[] = [];
  const erroredIds = new Set<string>();
  let firstError: { code?: string; message: string } | null = null;
  for (const group of groupMessagesForWrite(writable)) {
    let q = supabase
      .from("contact_messages")
      .update({ status: to, handled_by: session.user_id, handled_at: stamp })
      .in("id", group.ids)
      .eq("status", group.from);
    q = group.handledBy === null ? q.is("handled_by", null) : q.eq("handled_by", group.handledBy);
    q = group.handledAt === null ? q.is("handled_at", null) : q.eq("handled_at", group.handledAt);
    const { data, error } = await q.select("id");
    if (error) {
      firstError ??= error;
      for (const id of group.ids) erroredIds.add(id);
      continue;
    }
    const got = new Set((data ?? []).map((r) => r.id));
    for (const w of writable) if (got.has(w.id)) changed.push(w);
  }
  const changedSet = new Set(changed.map((c) => c.id));
  for (const w of writable) {
    if (changedSet.has(w.id)) continue;
    skipped.push({ id: w.id, reason: erroredIds.has(w.id) ? MESSAGE_WRITE_FAILED_REASON : MESSAGE_CHANGED_REASON });
  }

  if (changed.length > 0) {
    const { ip, ua } = await ipAndAgent();
    await Promise.all(
      changed.map((row) =>
        audit({
          actor_id: session.user_id,
          actor_type: "staff",
          action: "contact_message.status_changed",
          resource_type: "contact_message",
          resource_id: row.id,
          metadata: {
            from: row.from,
            to,
            previous_handled_by: row.handled_by,
            previous_handled_at: row.handled_at,
            handled_at: stamp,
            bulk_batch_id: batchId,
            bulk_batch_size: ids.length,
          },
          ip_address: ip,
          user_agent: ua,
        }),
      ),
    );
    revalidatePath("/staff/messages");
    for (const row of changed) revalidatePath(`/staff/messages/${row.id}`);
    revalidatePath("/staff", "layout");
  }
  if (firstError && changed.length === 0) return { ok: false, error: translatePgError(firstError) };

  // Every id sent lands in exactly one of changedIds / skipped, in input order.
  const reasonOf = new Map(skipped.map((s) => [s.id, s.reason]));
  return {
    ok: true,
    changedIds: ids.filter((id) => changedSet.has(id)),
    skipped: ids.filter((id) => reasonOf.has(id)).map((id) => ({ id, reason: reasonOf.get(id)! })),
    ...(changed.length > 0 ? { batchId } : {}),
  };
}
```

Note: if the TypeScript types of the reassigned `q` complain, declare it with `let q = …` exactly as above — `.is`/`.eq` on a `PostgrestFilterBuilder` return the same builder type. If `translatePgError`'s parameter type differs from `{ code?: string; message: string }`, type `firstError` with `Parameters<typeof translatePgError>[0] | null`.

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts"`

- [ ] **Step 6: Run the use-server export guard + typecheck**

Run: `npx vitest run src/lib/server/use-server-exports.test.ts && npm run -s typecheck`
Expected: PASS (only async functions and erased types are exported from actions.ts).

- [ ] **Step 7: Commit**

```bash
git add src/lib/audit/bulk-batch.ts "src/app/(staff)/staff/(dashboard)/messages/actions.ts" "src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts"
git commit -m "feat(messages): bulk status change with a stale-selection guard and per-message audit rows"
```

### Task A4: `undoMessageStatusManyAction` (10-minute Undo)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/messages/actions.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `actions.bulk.test.ts` (add `undoMessageStatusManyAction` to the `./actions` import and `BULK_UNDO_VIA, CHANGED_SINCE_REASON, UNDO_ALREADY, UNDO_EXPIRED` from `@/lib/ui/bulk-undo`):

```ts
const BATCH = "0b7c3d2e-1111-4111-8111-000000000009";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const STAMP = new Date(NOW - 60_000).toISOString();
/** The same instant as PostgREST reads it back ("+00:00"). */
const pg = (isoZ: string) => isoZ.replace("Z", "+00:00");
let seq = 0;
function bulkAudit(n: number, m: Row, over: Row = {}): Row {
  seq += 1;
  return {
    id: `a-${String(seq).padStart(5, "0")}`,
    actor_id: ME,
    resource_type: "contact_message",
    resource_id: id(n),
    action: "contact_message.status_changed",
    metadata: { bulk_batch_id: BATCH, handled_at: STAMP, ...m },
    created_at: new Date(NOW - 60_000 + seq * 10).toISOString(),
    ...over,
  };
}

describe("undoMessageStatusManyAction", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("puts each message back to its status AND its previous handler, and audits the undo", async () => {
    db.seed("contact_messages", [
      msg(1, { status: "closed", handled_by: ME, handled_at: pg(STAMP) }),
      msg(2, { status: "new", handled_by: ME, handled_at: pg(STAMP) }),
    ]);
    db.seed("audit_log", [
      bulkAudit(1, { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null }),
      bulkAudit(2, { from: "booked", to: "new", previous_handled_by: OTHER, previous_handled_at: "2026-09-29T01:00:00+00:00" }),
    ]);
    const r = await undoMessageStatusManyAction({ batchId: BATCH });
    expect(r).toEqual({ ok: true, restoredIds: [id(1), id(2)], notRestored: [] });
    expect(db.row("contact_messages", id(1))).toMatchObject({ status: "new", handled_by: null, handled_at: null });
    expect(db.row("contact_messages", id(2))).toMatchObject({
      status: "booked", handled_by: OTHER, handled_at: "2026-09-29T01:00:00+00:00",
    });
    const undoRows = audits().filter((a) => meta(a).via === BULK_UNDO_VIA);
    expect(undoRows.map((a) => [a.resource_id, meta(a).from, meta(a).to, meta(a).undo_of_batch])).toEqual([
      [id(1), "closed", "new", BATCH],
      [id(2), "new", "booked", BATCH],
    ]);
  });

  it("refuses a message someone changed since (newer audit row) and one whose row no longer matches", async () => {
    db.seed("contact_messages", [
      msg(1, { status: "closed", handled_by: ME, handled_at: pg(STAMP) }),
      msg(2, { status: "replied", handled_by: OTHER, handled_at: "2026-09-30T11:59:30+00:00" }), // moved on, no audit row seen
    ]);
    db.seed("audit_log", [
      bulkAudit(1, { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null }),
      bulkAudit(2, { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null }),
      { id: "a-99999", actor_id: OTHER, resource_type: "contact_message", resource_id: id(1),
        action: "contact_message.notes_updated", metadata: { length: 4 }, created_at: new Date(NOW - 5_000).toISOString() },
    ]);
    const r = await undoMessageStatusManyAction({ batchId: BATCH });
    expect(r).toEqual({
      ok: true,
      restoredIds: [],
      notRestored: [
        { id: id(1), reason: CHANGED_SINCE_REASON },
        { id: id(2), reason: CHANGED_SINCE_REASON },
      ],
    });
    expect(db.row("contact_messages", id(1)).status).toBe("closed");
    expect(db.row("contact_messages", id(2)).status).toBe("replied");
  });

  it("is only for the same person, within 10 minutes, once", async () => {
    db.seed("contact_messages", [msg(1, { status: "closed", handled_by: ME, handled_at: pg(STAMP) })]);
    db.seed("audit_log", [bulkAudit(1, { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null })]);

    h.session = { user_id: OTHER, role: "admin" };
    expect(await undoMessageStatusManyAction({ batchId: BATCH })).toEqual({ ok: false, error: UNDO_EXPIRED });

    h.session = { user_id: ME, role: "reception" };
    vi.setSystemTime(NOW + 10 * 60_000);
    expect(await undoMessageStatusManyAction({ batchId: BATCH })).toEqual({ ok: false, error: UNDO_EXPIRED });

    vi.setSystemTime(NOW);
    db.seed("audit_log", [{ id: "a-88888", actor_id: ME, resource_type: "contact_message", resource_id: id(1),
      action: "contact_message.status_changed", metadata: { undo_of_batch: BATCH }, created_at: new Date(NOW - 1_000).toISOString() }]);
    expect(await undoMessageStatusManyAction({ batchId: BATCH })).toEqual({ ok: false, error: UNDO_ALREADY });
  });

  it("refuses a non-inbox role before reading the batch", async () => {
    h.session = { user_id: ME, role: "medtech" };
    const r = await undoMessageStatusManyAction({ batchId: BATCH });
    expect(r).toEqual({ ok: false, error: "Only reception or admin can manage website messages." });
    expect(db.calls).toEqual([]);
  });
});
```

Adjust the exact `UNDO_EXPIRED` expectation for the "other actor" case to whatever `loadOwnBatchRows` returns when the actor has no rows (it returns `UNDO_EXPIRED` today — `allRows.length === 0`).

- [ ] **Step 2: Run — expect FAIL** (`undoMessageStatusManyAction` not exported)

- [ ] **Step 3: Implement** — in `messages/actions.ts` add imports:

```ts
import { loadOwnBatchRows } from "@/lib/audit/bulk-batch";
import {
  BULK_UNDO_VIA,
  CHANGED_SINCE_REASON,
  UNDO_ALREADY,
  UNDO_EXPIRED,
  type BulkUndoResult,
} from "@/lib/ui/bulk-undo";
import { bucketMessageUndo, planMessageUndo } from "@/lib/contact-messages/bulk-status"; // merge into the bulk-status import
```

and the action:

```ts
/**
 * Undo for the inbox bulk bar: for 10 minutes, only for the person who ran
 * it, puts every message that bulk call changed back to the status AND the
 * handler it had — read from that call's own audit rows (bulk_batch_id),
 * never from the browser. A message is reversed only while it is still
 * exactly as the call left it (status, handler = caller, the call's own
 * handled_at stamp) and nothing newer was logged for it.
 */
export async function undoMessageStatusManyAction(input: unknown): Promise<BulkUndoResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = z.object({ batchId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: UNDO_EXPIRED };

  const loaded = await loadOwnBatchRows({
    actorId: session.user_id,
    batchId: parsed.data.batchId,
    resourceType: "contact_message",
    nowMs: Date.now(),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.alreadyUndone) return { ok: false, error: UNDO_ALREADY };
  const entries = planMessageUndo(loaded.rows);
  if (entries.length === 0) return { ok: false, error: UNDO_EXPIRED };

  const notRestored: Array<{ id: string; reason: string }> = [];
  const toWrite = entries.filter((e) => {
    if (!loaded.changedSince.has(e.id)) return true;
    notRestored.push({ id: e.id, reason: CHANGED_SINCE_REASON });
    return false;
  });

  const supabase = await createClient();
  const undoBatchId = crypto.randomUUID();
  const moved: Array<{ id: string; current: string; restoreTo: string }> = [];
  const erroredIds = new Set<string>();
  for (const bucket of bucketMessageUndo(toWrite)) {
    const { data, error } = await supabase
      .from("contact_messages")
      .update({ status: bucket.restoreTo, handled_by: bucket.previousHandledBy, handled_at: bucket.previousHandledAt })
      .in("id", bucket.ids)
      .eq("status", bucket.current)
      .eq("handled_by", session.user_id)
      .eq("handled_at", bucket.stamp)
      .select("id");
    if (error) {
      for (const id of bucket.ids) erroredIds.add(id);
      continue;
    }
    for (const row of data ?? []) moved.push({ id: row.id, current: bucket.current, restoreTo: bucket.restoreTo });
  }
  const movedIds = new Set(moved.map((m) => m.id));
  for (const e of toWrite) {
    if (movedIds.has(e.id)) continue;
    notRestored.push({
      id: e.id,
      reason: erroredIds.has(e.id) ? "could not be undone just now — try again" : CHANGED_SINCE_REASON,
    });
  }

  if (moved.length > 0) {
    const { ip, ua } = await ipAndAgent();
    await Promise.all(
      moved.map((row) =>
        audit({
          actor_id: session.user_id,
          actor_type: "staff",
          action: "contact_message.status_changed",
          resource_type: "contact_message",
          resource_id: row.id,
          metadata: {
            from: row.current,
            to: row.restoreTo,
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
    revalidatePath("/staff/messages");
    for (const row of moved) revalidatePath(`/staff/messages/${row.id}`);
    revalidatePath("/staff", "layout");
  }
  if (erroredIds.size > 0 && moved.length === 0) {
    return { ok: false, error: "Could not undo — refresh the inbox and check the messages." };
  }
  // Input order (the audit order), so the bar's "not undone" list is stable.
  return { ok: true, restoredIds: entries.map((e) => e.id).filter((id) => movedIds.has(id)), notRestored };
}
```

Note the Undo write uses `.eq("handled_at", bucket.stamp)` with the "Z" spelling the bulk call wrote — Postgres compares timestamptz as instants, and the fake DB does too.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts" src/lib/audit`

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/messages/actions.ts" "src/app/(staff)/staff/(dashboard)/messages/actions.bulk.test.ts"
git commit -m "feat(messages): 10-minute Undo for a bulk status change, restoring the previous handler too"
```

### Task A5: `MessagesBulkBar` (client)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.test.tsx`

- [ ] **Step 1: Write the failing jsdom test** — model it on `appointments/appointments-bulk-bar.test.tsx` (read its harness: it renders the real `SelectionProvider` + `RowSelectCheckbox` + `SelectAllCheckbox` around the bar and mocks only `./actions` and `next/navigation`). Required cases, each with real assertions:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  updateMessageStatusManyAction: vi.fn(),
  undoMessageStatusManyAction: vi.fn(),
}));

import { undoMessageStatusManyAction, updateMessageStatusManyAction } from "./actions";
import { MessagesBulkBar, type MessageRowInfo } from "./messages-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { UNDO_EXPIRED } from "@/lib/ui/bulk-undo";

const ROWS: Record<string, MessageRowInfo> = {
  m1: { label: "Ana Cruz", status: "new" },
  m2: { label: "Ben Diaz", status: "booked" },
  m3: { label: "Cy Ong", status: "closed" },
};

function Harness({ resetKey = "k" }: { resetKey?: string }) {
  return (
    <SelectionProvider resetKey={resetKey}>
      {Object.entries(ROWS).map(([key, r]) => (
        <RowSelectCheckbox key={key} rowKey={key} kinds={[r.status]} label={`Select ${r.label}`} />
      ))}
      <MessagesBulkBar rowsByKey={ROWS} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(updateMessageStatusManyAction).mockReset();
  vi.mocked(undoMessageStatusManyAction).mockReset();
  router.refresh.mockReset();
});
afterEach(cleanup);

describe("MessagesBulkBar", () => {
  it("shows only the buttons the selection allows, with eligible counts", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    expect(screen.getByRole("button", { name: "Mark replied (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark closed (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen (1)" })).toBeTruthy();
  });

  it("sends each eligible message with the status the operator saw, and names what was skipped", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({
      ok: true, changedIds: ["m1"], skipped: [{ id: "m2", reason: "changed since you selected it — refresh to see its status" }], batchId: "b-1",
    });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (2)" }));
    expect(updateMessageStatusManyAction).toHaveBeenCalledWith({
      entries: [{ id: "m1", from: "new" }, { id: "m2", from: "booked" }],
      to: "closed",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Marked 1 of 2 messages closed.");
    expect(status.textContent).toContain("Ben Diaz: changed since you selected it");
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("rows a button does not cover stay selected", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1"], skipped: [], batchId: "b-1" });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Cy Ong"));
    await userEvent.click(screen.getByRole("button", { name: "Mark replied (1)" }));
    expect((screen.getByLabelText("Select Cy Ong") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select Ana Cruz") as HTMLInputElement).checked).toBe(false);
  });

  it("a refused call keeps the selection and alerts", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: false, error: "nope" });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (1)" }));
    expect(alertSpy).toHaveBeenCalledWith("nope");
    expect((screen.getByLabelText("Select Ana Cruz") as HTMLInputElement).checked).toBe(true);
    alertSpy.mockRestore();
  });

  it("Undo names what came back and what did not; an expired Undo hides the button", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1", "m2"], skipped: [], batchId: "b-1" });
    vi.mocked(undoMessageStatusManyAction).mockResolvedValueOnce({
      ok: true, restoredIds: ["m1"], notRestored: [{ id: "m2", reason: "changed again since — refresh to see its status" }],
    });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (2)" }));
    await userEvent.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(undoMessageStatusManyAction).toHaveBeenCalledWith({ batchId: "b-1" });
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toContain("Undone — 1 message is back to what it was.");
    expect(text).toContain("Ben Diaz: changed again since");
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("a refused Undo (expired) drops the Undo button", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1"], skipped: [], batchId: "b-1" });
    vi.mocked(undoMessageStatusManyAction).mockResolvedValueOnce({ ok: false, error: UNDO_EXPIRED });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (1)" }));
    await userEvent.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect((await screen.findByRole("status")).textContent).toContain(UNDO_EXPIRED);
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("a resetKey change drops the selection and the bar", async () => {
    const { rerender } = render(<Harness resetKey="a" />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    expect(screen.getByRole("region", { name: "Selected rows" })).toBeTruthy();
    rerender(<Harness resetKey="b" />);
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.test.tsx"`

- [ ] **Step 3: Implement** — `messages-bulk-bar.tsx`

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import { formatBulkOutcome } from "@/lib/ui/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import { MESSAGE_BULK_BUTTONS, bulkMessagePlan } from "@/lib/contact-messages/bulk-status";
import type { ContactMessageStatus } from "@/lib/contact-messages/labels";
import { undoMessageStatusManyAction, updateMessageStatusManyAction } from "./actions";

export interface MessageRowInfo {
  /** The sender's name — how the outcome panel names a message. */
  label: string;
  status: ContactMessageStatus;
}

interface OutcomeUndo {
  batchId: string;
  doneAt: number;
  /** Snapshotted: the refresh after the action can drop these rows from the page. */
  labelOf: Record<string, string>;
}

interface Outcome {
  message: string;
  /** selectionEdits when set — a new deliberate edit drops the outcome (same rule as the other bars). */
  edits: number;
  undo: OutcomeUndo | null;
}

const NOUN = { one: "message", many: "messages" };

// Website Messages bulk bar (spec 2026-09-25 §7): the transitions the detail
// page offers, over the eligible subset of the selection; every message not
// changed is named in the outcome, and a 10-minute ↶ Undo reverses the call.
export function MessagesBulkBar({ rowsByKey }: { rowsByKey: Record<string, MessageRowInfo> }) {
  const { state, clearKeys, count, selectionEdits } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [undoing, startUndo] = useTransition();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const selected = [...state.keys()].flatMap((key) =>
    rowsByKey[key] ? [{ key, status: rowsByKey[key].status }] : [],
  );
  const plan = bulkMessagePlan(selected);
  if (outcome !== null && selectionEdits !== outcome.edits) setOutcome(null);

  function run(button: (typeof MESSAGE_BULK_BUTTONS)[number]) {
    const keys = plan[button.to];
    if (keys.length === 0 || pending) return;
    const entries = keys.map((key) => ({ id: key, from: rowsByKey[key]!.status }));
    const labelOf = Object.fromEntries(keys.map((k) => [k, rowsByKey[k]!.label]));
    start(async () => {
      const result = await updateMessageStatusManyAction({ entries, to: button.to });
      if (!result.ok) {
        alert(result.error);
        router.refresh();
        return;
      }
      setOutcome({
        message: formatBulkOutcome({
          verb: button.verb,
          tail: button.tail || undefined,
          noun: NOUN,
          sent: keys.length,
          changed: result.changedIds.length,
          notChanged: result.skipped.map((s) => ({ label: labelOf[s.id] ?? "A message", reason: s.reason })),
        }),
        edits: selectionEdits,
        undo:
          result.batchId && result.changedIds.length > 0
            ? { batchId: result.batchId, doneAt: Date.now(), labelOf }
            : null,
      });
      clearKeys(keys);
      router.refresh();
    });
  }

  function runUndo(u: OutcomeUndo) {
    if (undoing) return;
    const previousMessage = outcome?.message ?? "";
    startUndo(async () => {
      const r = await undoMessageStatusManyAction({ batchId: u.batchId });
      if (!r.ok) {
        const gone = r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY;
        setOutcome({ message: `${r.error}\n\n${previousMessage}`, edits: selectionEdits, undo: gone ? null : u });
        return;
      }
      setOutcome({
        message: undoOutcomeMessage(NOUN, {
          restored: r.restoredIds.length,
          notRestored: r.notRestored.map((n) => ({ label: u.labelOf[n.id] ?? "A message", reason: n.reason })),
        }),
        edits: selectionEdits,
        undo: null,
      });
      router.refresh();
    });
  }

  const undoProp = (undo: OutcomeUndo | null) =>
    undo ? { doneAt: undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoing, onUndo: () => runUndo(undo) } : null;

  if (count === 0) {
    return outcome ? (
      <BulkOutcomePanel message={outcome.message} undo={undoProp(outcome.undo)} onDismiss={() => setOutcome(null)} />
    ) : null;
  }

  return (
    <BulkBar noun="message">
      {outcome ? (
        <BulkOutcomePanel inline message={outcome.message} undo={undoProp(outcome.undo)} onDismiss={() => setOutcome(null)} />
      ) : null}
      {MESSAGE_BULK_BUTTONS.map((button) => {
        const n = plan[button.to].length;
        if (n === 0) return null;
        return (
          <Button key={button.to} type="button" size="sm" variant={button.variant} disabled={pending} onClick={() => run(button)}>
            {button.label} ({n})
          </Button>
        );
      })}
    </BulkBar>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.tsx" "src/app/(staff)/staff/(dashboard)/messages/messages-bulk-bar.test.tsx"
git commit -m "feat(messages): inbox bulk bar — named outcome and 10-minute Undo on the shared kit"
```

### Task A6: Wire the inbox page

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/messages/page.tsx`

- [ ] **Step 1: Imports** — add:

```tsx
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import { isContactMessageStatus } from "@/lib/contact-messages/labels"; // merge into the existing labels import
import { MessagesBulkBar, type MessageRowInfo } from "./messages-bulk-bar";
```

- [ ] **Step 2: Selection data** — after `const isFiltered = …`:

```tsx
  // Bulk selection (spec 2026-09-25 §7): one row per message, kinds = its
  // status (a refresh that changes the status prunes the row from the
  // selection). Any change to what the list shows or its order drops the
  // selection — SelectionProvider watches this key.
  const selectionResetKey = [status, corporateOnly ? "corporate" : "", query, sort.key, sort.dir, String(page), String(size)].join("|");
  const selectableRows = rows.filter((r) => isContactMessageStatus(r.status));
  const selectionEntries = selectableRows.map((r) => ({ rowKey: r.id, kinds: [r.status], weight: 1 }));
  const rowsByKey: Record<string, MessageRowInfo> = Object.fromEntries(
    selectableRows.map((r) => [r.id, { label: r.name, status: r.status as MessageRowInfo["status"] }]),
  );
```

- [ ] **Step 3: Markup** — wrap from the `<Panel className="overflow-x-auto">` through `<ListPagination … />` in `<SelectionProvider resetKey={selectionResetKey}> … <MessagesBulkBar rowsByKey={rowsByKey} /></SelectionProvider>`. In the `<thead>` row, add first:

```tsx
              <th className="w-12 px-2 py-3">
                <SelectAllCheckbox entries={selectionEntries} label="Select all messages on this page" />
              </th>
```

In the empty-state row change `colSpan={8}` to `colSpan={9}`. In each body row add first:

```tsx
                  <td className="px-2 py-2 align-middle">
                    {isContactMessageStatus(r.status) ? (
                      <RowSelectCheckbox
                        rowKey={r.id}
                        kinds={[r.status]}
                        label={`Select message from ${r.name}`}
                      />
                    ) : null}
                  </td>
```

- [ ] **Step 4: Typecheck + lint + the messages tests**

Run: `npm run -s typecheck && npm run -s lint && npx vitest run "src/app/(staff)/staff/(dashboard)/messages" src/lib/contact-messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/messages/page.tsx"
git commit -m "feat(messages): checkbox column, select-all and the bulk bar on the inbox"
```

### Task A7: Fixtures + browser checks M1–M7

**Files:**
- Modify: `scripts/seed/bulk-select-fixtures.sql` (the `-- ---- website messages` block, ~line 139)
- Modify: `scripts/browser-check/bulk-select.ts`

- [ ] **Step 1: Fixtures** — extend the insert so every source status exists (the booked row links to no appointment; a Reopen of it is the check):

```sql
insert into contact_messages (name, phone, message, status, kind) values
  ('BSQ Sender One', '09170000011', 'bsq-fixture: price of CBC?', 'new', 'general'),
  ('BSQ Sender Two', '09170000012', 'bsq-fixture: corporate APE for 40 staff', 'new', 'corporate'),
  ('BSQ Sender Three', '09170000013', 'bsq-fixture: thanks!', 'replied', 'general'),
  ('BSQ Sender Four', '09170000014', 'bsq-fixture: booked already', 'booked', 'general'),
  ('BSQ Sender Five', '09170000015', 'bsq-fixture: done', 'closed', 'general');
```

- [ ] **Step 2: Add `sectionMessages(c, admin)`** to `bulk-select.ts`, modelled on `sectionNamedOutcome` / `sectionUndo` (read both first; use the existing `check`, `goto`, `barText`, `outcomeText`, `pinnedBottom`, `waitForCount`, `latestBatchId`, `undoRowCount` helpers and `c.sql` for DB assertions). Every check asserts with `c.expect`. Navigate to `${APP_BASE}/staff/messages?status=all&q=BSQ%20Sender`.
  - **M1** select-all on the page → bar shows `5 messages selected`; buttons `Mark replied (2)`, `Mark closed (4)`, `Reopen (3)`; bar is pinned to the viewport bottom (`pinnedBottom`).
  - **M2** Escape clears the selection; the search box focused + Escape does not.
  - **M3** select One + Four (booked) → `Mark closed (2)` → outcome `Marked 2 messages closed.`; DB: both `closed`, `handled_by` = admin id; two `contact_message.status_changed` audit rows with the same `bulk_batch_id`, `previous_handled_by` null.
  - **M4** ↶ Undo → outcome `Undone — 2 messages are back to what they were.`; DB: One is `new`, Four is `booked`, both `handled_by`/`handled_at` back to what the fixture had (null); `undoRowCount(batch) === 2`.
  - **M5** stale click: select Sender Two; in DB set it to `replied` (`update contact_messages set status='replied' where name='BSQ Sender Two'`); click `Mark closed (1)` → outcome names `BSQ Sender Two: changed since you selected it`; DB still `replied`; no audit row for it in the new batch.
  - **M6** the detail page of Sender One shows the bulk actor under "handled by" after a bulk Mark replied (spec §9 item 6).
  - **M7** 390px: `page.setViewportSize({ width: 390, height: 844 })`, select two rows → bar visible, checkboxes ≥ 44px tall (`rowBoxes`), `document.documentElement.scrollWidth <= 390`.
  - Role (spec §9 item 5): medtech is redirected from `/staff/messages` (the page's existing guard) — assert with the `med` page that the URL is not `/staff/messages` after goto. Server-side refusal is unit-tested (Task A3/A4).
  Call it from `main()` after `sectionDatedCallbacks`, preceded by `await reseed(c);`. Add the sections' names to the file's header comment.

- [ ] **Step 3: Run the browser check on a quiet machine** — local stack up, dev server on :3007 with the LOCAL env (`PORT=3007 npm run dev` in this worktree), limiter cleared (command in the header), no vitest running:

Run: `npm run check:bulk-select`
Expected: every check PASS (previous count 34 + M1–M7 + role). Record the count for the PR.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed/bulk-select-fixtures.sql scripts/browser-check/bulk-select.ts
git commit -m "test(messages): browser checks M1–M7 for the inbox bulk bar and Undo"
```

### Task A8: Guide, gates, review, PR

**Files:**
- Modify: `docs/drmed-user-guide.html` (§3.11, starts ~line 754)

- [ ] **Step 1: Guide paragraph** — add to §3.11, after the paragraph that explains the status buttons, in the guide's own markup (`<p>`, `<kbd class="ui">`, `<span class="status">`, `<q>`):

```html
      <p><b>Several at once.</b> Tick the box at the start of each row (or the box in the header for every message on the page) and a bar appears at the bottom of the screen with the moves those messages allow: <kbd class="ui">Mark replied</kbd>, <kbd class="ui">Mark closed</kbd> and <kbd class="ui">Reopen</kbd>, each with how many of the ticked messages it applies to — a <span class="status">Booked</span> message can only be closed or reopened, never marked replied. Every message you move shows you as its handler. The bar then lists each message it did not change and why — usually <q>changed since you selected it</q>, because a colleague moved it first; nothing a colleague did is overwritten. For 10 minutes, <kbd class="ui">↶ Undo</kbd> puts every message back — status and handler — unless someone changed it again in the meantime. <kbd>Esc</kbd> clears the selection; <kbd>?</kbd> on the bar lists the keyboard shortcuts.</p>
```

Check the shortcuts popover's real trigger text in `src/components/staff/row-selection/shortcuts-help.tsx` and word the last sentence to match it exactly.

- [ ] **Step 2: Full gates**

Run: `npm test > /tmp/claude-a-test.log 2>&1; tail -5 /tmp/claude-a-test.log; npm run -s typecheck && npm run -s lint`
Expected: all green. (Scratchpad path, not /tmp, when run by Claude.)

- [ ] **Step 3: Whole-branch review** — dispatch a Sonnet `superpowers:code-reviewer` over `git diff origin/main...HEAD` against this plan's PR A section + spec §7. Fix confirmed findings (owner rule 4: close real gaps by matching existing patterns).

- [ ] **Step 4: Push + open PR (no migration)**, title `feat(messages): bulk status changes with 10-minute Undo on the Website Messages inbox`. Body: summary, browser-check count, "no migration", test count. Stop for the owner's merge OK. At merge: merge origin/main, bump the guide version/date (four markers), push, merge, confirm the Vercel prod deploy (if it fails on the known next/font glitch: `npx vercel redeploy <failed-url> --target production --scope ian-jamilas-projects` from `~/Claude/DRMed`).

---

# PR B — Queue Undo hardening (items 2, 3, 5)

Fresh worktree: `git worktree add .worktrees/queue-undo-atomic -b feat/queue-undo-atomic origin/main && cd .worktrees/queue-undo-atomic && npm ci && cp ../bulk-select-next/.env.local .` (never symlink node_modules). Migration **0200** and **P0082** are already claimed (`npm run claim -- list` shows them); do not re-claim.

**What changes for the operator:** after a bulk Unclaim or bulk Delete of a chemistry panel, ↶ Undo now puts the whole panel back in ONE database step — every member or none — instead of writing member by member and trying to take a partial result back. The panel row's own Claim button gets the same 10-minute Undo as the bulk bar.

### Task B1: Migration 0200 + smoke test + error translation + types

**Files:**
- Create: `supabase/migrations/0200_panel_undo_all_or_nothing.sql`
- Create: `supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql`
- Modify: `src/lib/accounting/pg-errors.ts` (after the P0077 case)
- Modify: `src/types/database.ts` (Functions, next to `unclaim_panel_members`)
- Modify: `src/lib/patients/write-guards.test.ts` (`KNOWN_WRITER_RPCS`)

- [ ] **Step 1: Write the migration** — `supabase/migrations/0200_panel_undo_all_or_nothing.sql`

```sql
-- 0200_panel_undo_all_or_nothing.sql
-- =============================================================================
-- The lab queue's 10-minute bulk Undo, for a consolidated chemistry panel, in
-- ONE statement each (P0082).
--
-- 0191 made CLAIMING and HANDING BACK a panel all-or-nothing. Undo of a bulk
-- Unclaim (put every member back under its old holder) and Undo of a bulk
-- Delete (restore every member) still wrote member by member from the app,
-- and when one member had changed in between they tried to take the others
-- back with a second write — a separate transaction that can itself fail, and
-- whose predicates cannot tell this Undo apart from a newer change. These two
-- functions do the whole panel in one UPDATE with a row-count check: when
-- fewer rows match than were asked for, they raise P0082 and the whole Undo
-- rolls back. A concurrent writer blocks on the row locks and re-evaluates
-- after the first commits, so exactly one wins.
--
-- reclaim_panel_members(ids, holders, started_at): invoker rights, called
-- from the staff JWT like 0191's pair. Each member goes back to ITS OWN
-- holder (an admin's hand-back of a split panel recorded one per member) and
-- to the exact started_at it had (null → now()). Only while every member is
-- still requested, unassigned, live, on a live visit. A non-admin may only
-- put back claims in their own name; an admin (effective role) may put back
-- anyone's, as the admin Unclaim that made them could hand back anyone's.
-- 0190's test_requests_claim_holder_guard still judges every holder (P0075
-- rolls the whole Undo back).
--
-- restore_panel_members(visit, ids, deleted_at): service_role only — the
-- queue restore already runs on the admin client (queue-restore-core.ts),
-- with the role, reason and active-patient checks in the app. Every member
-- must still be deleted at EXACTLY the deleted_at the bulk delete stamped (a
-- restore-and-re-delete by someone else since carries a different one), on
-- that visit, top-level (components ride their header's cascade, 0125), and
-- the visit itself live.
-- =============================================================================

create or replace function public.reclaim_panel_members(
  p_test_request_ids uuid[],
  p_holders uuid[],
  p_started_at timestamptz[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_wanted    integer;
  v_reclaimed integer;
begin
  if v_uid is null then
    raise exception 'Sign in to undo.' using errcode = '42501';
  end if;
  if p_test_request_ids is null or p_holders is null or p_started_at is null
     or cardinality(p_test_request_ids) <> cardinality(p_holders)
     or cardinality(p_test_request_ids) <> cardinality(p_started_at) then
    raise exception 'Could not read this report — refresh the queue.' using errcode = 'P0082';
  end if;

  select count(*) into v_wanted
    from unnest(p_test_request_ids, p_holders) as x(id, holder);
  if v_wanted = 0 or v_wanted > 200
     or exists (select 1 from unnest(p_test_request_ids, p_holders) as x(id, holder)
                 where x.id is null or x.holder is null)
     or (select count(distinct x.id) from unnest(p_test_request_ids) as x(id)) <> v_wanted then
    raise exception 'Nothing to put back in this report.' using errcode = 'P0082';
  end if;

  if not public.has_role(array['admin'])
     and exists (select 1 from unnest(p_holders) as h(holder) where h.holder <> v_uid) then
    raise exception 'You can only put back a claim in your own name.' using errcode = 'P0082';
  end if;

  update public.test_requests t
     set status      = 'in_progress',
         assigned_to = x.holder,
         started_at  = coalesce(x.started_at, now())
    from unnest(p_test_request_ids, p_holders, p_started_at) as x(id, holder, started_at)
   where t.id = x.id
     and t.status = 'requested'
     and t.assigned_to is null
     and t.deleted_at is null
     and exists (select 1 from public.visits v where v.id = t.visit_id and v.deleted_at is null);
  get diagnostics v_reclaimed = row_count;

  if v_reclaimed <> v_wanted then
    -- Rolls back the members the UPDATE above did put back: all or nothing.
    raise exception 'Someone claimed or changed part of this report since — nothing was put back.'
      using errcode = 'P0082';
  end if;

  return v_reclaimed;
end;
$$;

comment on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) is
  'Undo of a bulk hand-back: all-or-nothing re-claim of a consolidated report''s members, each under its own previous holder (p_holders) at its previous started_at (p_started_at, null = now()). Non-admins may only put back their own. Raises P0082 and changes nothing otherwise. Invoker rights: RLS and test_requests_claim_holder_guard (0190) apply.';

revoke execute on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) from public, anon;
grant  execute on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) to authenticated, service_role;

create or replace function public.restore_panel_members(
  p_visit_id uuid,
  p_test_request_ids uuid[],
  p_deleted_at timestamptz[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_wanted   integer;
  v_restored integer;
begin
  if p_visit_id is null or p_test_request_ids is null or p_deleted_at is null
     or cardinality(p_test_request_ids) <> cardinality(p_deleted_at) then
    raise exception 'Could not read this report — refresh the queue.' using errcode = 'P0082';
  end if;

  select count(*) into v_wanted
    from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at);
  if v_wanted = 0 or v_wanted > 200
     or exists (select 1 from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at)
                 where x.id is null or x.deleted_at is null)
     or (select count(distinct x.id) from unnest(p_test_request_ids) as x(id)) <> v_wanted then
    raise exception 'Nothing to restore in this report.' using errcode = 'P0082';
  end if;

  if exists (select 1 from public.visits v where v.id = p_visit_id and v.deleted_at is not null) then
    raise exception 'The visit itself is deleted — restore the visit first.' using errcode = 'P0082';
  end if;

  update public.test_requests t
     set deleted_at    = null,
         deleted_by    = null,
         delete_reason = null
    from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at)
   where t.id = x.id
     and t.visit_id = p_visit_id
     and t.deleted_at = x.deleted_at
     and t.parent_id is null;
  get diagnostics v_restored = row_count;

  if v_restored <> v_wanted then
    -- Rolls back the members the UPDATE above did restore: all or nothing.
    raise exception 'Part of this report was already restored or changed — nothing was restored.'
      using errcode = 'P0082';
  end if;

  return v_restored;
end;
$$;

comment on function public.restore_panel_members(uuid, uuid[], timestamptz[]) is
  'Undo of a bulk queue delete: all-or-nothing restore of a consolidated report''s top-level members on one live visit, each still deleted at exactly p_deleted_at. Raises P0082 and restores nothing otherwise. service_role only (the app checks role, reason and active patient first).';

revoke execute on function public.restore_panel_members(uuid, uuid[], timestamptz[]) from public, anon, authenticated;
grant  execute on function public.restore_panel_members(uuid, uuid[], timestamptz[]) to service_role;
```

- [ ] **Step 2: Write the smoke test** — `supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql`. Copy the structure of `supabase/tests/0191_claim_panel_members_smoke.sql` exactly (read it first: how it mints staff/patient/visit/services inside one `begin … rollback`, how it sets `request.jwt.claims` + `set local role authenticated`, and how it asserts a raise with a `do $$ … exception when sqlstate 'P0077' …$$` block). Assertions, each its own block that raises `'FAIL: <name>'` on the wrong outcome:
  1. reclaim: three requested/unassigned members → returns 3; each `assigned_to` = its own holder, `started_at` = the passed value; a null `started_at` element gets `now()`.
  2. reclaim: one member already `in_progress` → P0082; the other two still `requested`/unassigned (rolled back).
  3. reclaim: one member `deleted_at` set → P0082, nothing changed.
  4. reclaim: the visit deleted → P0082.
  5. reclaim as a non-admin with a holder ≠ caller → P0082 "own name"; as an admin with another medtech's holder → 3.
  6. reclaim with a holder whose role can't work the section (e.g. a reception staff id) → P0075 (0190 guard), nothing changed.
  7. reclaim: mismatched array lengths → P0082; empty arrays → P0082; a duplicate id → P0082.
  8. reclaim: as `anon` → `permission denied for function` (42501).
  9. restore (as `service_role`): three members deleted at T → returns 3, all `deleted_at`/`deleted_by`/`delete_reason` null.
  10. restore: one member's `deleted_at` ≠ passed → P0082, all three still deleted at their values.
  11. restore: visit deleted → P0082 with the visit message.
  12. restore: a member on another visit → P0082.
  13. restore: as `authenticated` → 42501 (no grant).
  14. ACL: `has_function_privilege('anon', 'public.reclaim_panel_members(uuid[],uuid[],timestamptz[])', 'execute')` is false; `authenticated` true; `has_function_privilege('authenticated', 'public.restore_panel_members(uuid,uuid[],timestamptz[])', 'execute')` false; `service_role` true for both.

- [ ] **Step 3: Apply to the LOCAL stack without resetting it** (the stack is shared across worktrees — never `db reset`). Check what the local ledger holds first, then apply the file and stamp the ledger:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select version from supabase_migrations.schema_migrations order by version desc limit 5;"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/0200_panel_undo_all_or_nothing.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "insert into supabase_migrations.schema_migrations (version, name, statements) values ('0200', 'panel_undo_all_or_nothing', array[]::text[]) on conflict do nothing;"
```

(If `psql` is missing, use a `node -e` one-off with `pg` from inside the worktree, as memory records for 0184/0193.)

- [ ] **Step 4: Run the smoke test — expect every assertion to pass**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql`
Expected: completes, no `FAIL:` notice, ends in `ROLLBACK`.

- [ ] **Step 5: Error translation** — `pg-errors.ts`, after the P0077 case:

```ts
    // 0200 reclaim_panel_members / restore_panel_members: the bulk Undo put
    // nothing back for this panel (all or nothing) — several messages, all
    // written for staff; pass them through like P0077.
    case "P0082":
      return err.message
        ? err.message
        : "Part of this report changed since — nothing was put back.";
```

- [ ] **Step 6: Types** — `src/types/database.ts`, in `Functions`, alphabetically:

```ts
      reclaim_panel_members: {
        Args: { p_holders: string[]; p_started_at: (string | null)[]; p_test_request_ids: string[] }
        Returns: number
      }
      restore_panel_members: {
        Args: { p_deleted_at: string[]; p_test_request_ids: string[]; p_visit_id: string }
        Returns: number
      }
```

(Or run `npm run db:types` against the local stack and check the diff only adds these two.)

- [ ] **Step 7: Write-guard registry** — `src/lib/patients/write-guards.test.ts`, in `KNOWN_WRITER_RPCS` after `unclaim_panel_members`:

```ts
  "reclaim_panel_members", // panel-writes.ts reclaimPanelMembers — all-or-nothing Undo of a panel hand-back (0200).
  "restore_panel_members", // panel-writes.ts restorePanelMembers — all-or-nothing Undo of a panel queue delete (0200).
```

- [ ] **Step 8: Run the registry-driven tests**

Run: `npx vitest run src/lib/accounting/pg-error-coverage.test.ts src/lib/patients/write-guards.test.ts && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 9: Record the P-code** — `.claude/skills/drmed-migrations/SKILL.md`, "Codes in use" line: add `P0082` with a one-sentence note next to P0077 (`reclaim_panel_members` / `restore_panel_members` refusing a panel Undo that isn't wholly reversible — 0200). CLAUDE.md: add 0200 to wherever the migration ledger note lists recent migrations (grep `0194` in CLAUDE.md to find it).

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0200_panel_undo_all_or_nothing.sql supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql src/lib/accounting/pg-errors.ts src/types/database.ts src/lib/patients/write-guards.test.ts .claude/skills/drmed-migrations/SKILL.md CLAUDE.md
git commit -m "feat(db): 0200 — panel Undo re-claim and restore in one all-or-nothing statement (P0082)"
```

### Task B2: `reclaimPanelMembers` / `restorePanelMembers` helpers

**Files:**
- Modify: `src/lib/actions/queue/panel-writes.ts`
- Create: `src/lib/actions/queue/panel-writes.undo.test.ts`

- [ ] **Step 1: Write the failing test** — `panel-writes.undo.test.ts` (FakeDb with an `rpc` hook that mirrors the SQL; mocks as in `queue/actions.undo-behaviour.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const h = vi.hoisted(() => ({ audit: vi.fn(async (e: Record<string, unknown>) => void e) }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));

import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { reclaimPanelMembers, restorePanelMembers } from "./panel-writes";
import type { StaffSession } from "@/lib/auth/require-staff";

const session = { user_id: "admin-1", role: "admin" } as unknown as StaffSession;
let db: FakeDb;
const P0082 = { code: "P0082", message: "Someone claimed or changed part of this report since — nothing was put back." };

function tr(id: string, over: Row = {}): Row {
  return {
    id, visit_id: "visit-1", status: "requested", assigned_to: null, started_at: null,
    deleted_at: null, deleted_by: null, delete_reason: null, parent_id: null,
    services: { name: `Svc ${id}`, code: `C-${id}` }, visits: { patient_id: "patient-1", deleted_at: null },
    ...over,
  };
}

beforeEach(() => {
  db = new FakeDb();
  h.audit.mockClear();
});

describe("reclaimPanelMembers", () => {
  it("calls reclaim_panel_members once with parallel arrays and audits one reassigned row per member", async () => {
    db.seed("test_requests", [tr("m1"), tr("m2")]);
    db.hooks.rpc = (rec) => {
      expect(rec.fn).toBe("reclaim_panel_members");
      return { data: 2, error: null };
    };
    const r = await reclaimPanelMembers(session, db.client() as never, {
      members: [
        { id: "m1", holder: "tech-a", startedAt: "2026-09-30T01:00:00.000Z" },
        { id: "m2", holder: "tech-b", startedAt: null },
      ],
      visitIdOf: () => "visit-1",
      auditExtra: { via: "bulk_undo", undo_of_batch: "b", bulk_batch_id: "u", panel_key: "k" },
    });
    expect(r).toEqual({ ok: true });
    expect(db.rpcCalls).toEqual([
      { fn: "reclaim_panel_members", args: {
        p_test_request_ids: ["m1", "m2"], p_holders: ["tech-a", "tech-b"],
        p_started_at: ["2026-09-30T01:00:00.000Z", null],
      } },
    ]);
    const rows = h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.map((a) => [a.action, a.resource_id, (a.metadata as Row).to])).toEqual([
      ["test_request.reassigned", "m1", "tech-a"],
      ["test_request.reassigned", "m2", "tech-b"],
    ]);
  });

  it("a P0082 refusal changes nothing and is translated", async () => {
    db.hooks.rpc = () => ({ data: null, error: P0082 });
    const r = await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }],
      visitIdOf: () => "visit-1",
    });
    expect(r).toEqual({ ok: false, error: P0082.message });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("retries once on a lost lifecycle race (P0072), never on P0082", async () => {
    let n = 0;
    db.hooks.rpc = () => (++n === 1 ? { data: null, error: { code: "P0072", message: "moved" } } : { data: 1, error: null });
    expect(await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }], visitIdOf: () => "visit-1",
    })).toEqual({ ok: true });
    expect(n).toBe(2);

    n = 0;
    db.hooks.rpc = () => (++n, { data: null, error: P0082 });
    await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }], visitIdOf: () => "visit-1",
    });
    expect(n).toBe(1);
  });
});

describe("restorePanelMembers", () => {
  const T = "2026-09-30T01:00:00.000Z";
  it("calls restore_panel_members once and audits one restored row per member with its prior delete info", async () => {
    db.seed("test_requests", [
      tr("m1", { deleted_at: "2026-09-30T01:00:00+00:00", delete_reason: "dup" }),
      tr("m2", { deleted_at: "2026-09-30T01:00:00+00:00", delete_reason: "dup" }),
    ]);
    db.hooks.rpc = (rec) => {
      expect(rec.fn).toBe("restore_panel_members");
      return { data: 2, error: null };
    };
    const r = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1",
      members: [{ id: "m1", deletedAt: T }, { id: "m2", deletedAt: T }],
      reason: "Undo of a bulk delete",
      auditExtra: { via: "bulk_undo", undo_of_batch: "b", bulk_batch_id: "u", panel_key: "k" },
    });
    expect(r).toEqual({ ok: true, restoredIds: ["m1", "m2"] });
    expect(db.rpcCalls[0]!.args).toEqual({ p_visit_id: "visit-1", p_test_request_ids: ["m1", "m2"], p_deleted_at: [T, T] });
    const rows = h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.map((a) => a.action)).toEqual(["test_request.restored", "test_request.restored"]);
    expect(rows[0]!.patient_id).toBe("patient-1");
    expect(rows[0]!.metadata).toMatchObject({
      visit_id: "visit-1", reason: "Undo of a bulk delete", service_name: "Svc m1", service_code: "C-m1",
      prior_delete_reason: "dup", via: "bulk_undo", panel_key: "k",
    });
  });

  it("a P0082 refusal restores nothing and audits nothing", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: "2026-09-30T01:00:00+00:00" })]);
    db.hooks.rpc = () => ({ data: null, error: { code: "P0082", message: "Part of this report was already restored or changed — nothing was restored." } });
    const r = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect(r).toEqual({ ok: false, error: "Part of this report was already restored or changed — nothing was restored." });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (exports missing)

Run: `npx vitest run src/lib/actions/queue/panel-writes.undo.test.ts`

- [ ] **Step 3: Implement** — append to `panel-writes.ts`:

```ts
/**
 * Undo of a bulk panel hand-back (0200): every member back under ITS OWN
 * previous holder, at its previous started_at, in one statement — or, when
 * any member was claimed, deleted or changed since, nothing (P0082). The
 * caller has already proven each holder can still hold the test and the
 * visit passes the payment gate; 0190's holder guard is the backstop.
 * Audited like the per-row reclaim it replaces: one test_request.reassigned
 * row per member (from null → holder).
 */
export async function reclaimPanelMembers(
  session: StaffSession,
  supabase: Supabase,
  args: {
    members: ReadonlyArray<{ id: string; holder: string; startedAt: string | null }>;
    visitIdOf: (testRequestId: string) => string | null;
    auditExtra?: Record<string, unknown>;
  },
): Promise<PanelOutcome> {
  const { error } = await withLifecycleRetry(() =>
    supabase.rpc("reclaim_panel_members", {
      p_test_request_ids: args.members.map((m) => m.id),
      p_holders: args.members.map((m) => m.holder),
      p_started_at: args.members.map((m) => m.startedAt),
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  for (const m of args.members) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.reassigned",
      resource_type: "test_request",
      resource_id: m.id,
      metadata: { visit_id: args.visitIdOf(m.id), from: null, to: m.holder, grouped: true, ...(args.auditExtra ?? {}) },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true };
}

/**
 * Undo of a bulk panel queue-delete (0200): every top-level member of one
 * visit's panel restored in one statement while each is still deleted at
 * exactly the deleted_at the bulk delete stamped — or nothing (P0082).
 * `admin` must be the service-role client (restore_panel_members is granted
 * to service_role only, like the queue restore it mirrors); the caller has
 * checked the role and that the visit's patient is active. Audited exactly
 * like restoreTestRequestsForVisit: one test_request.restored row per member.
 */
export async function restorePanelMembers(
  session: StaffSession,
  admin: Supabase,
  args: {
    visitId: string;
    members: ReadonlyArray<{ id: string; deletedAt: string }>;
    reason: string;
    auditExtra?: Record<string, unknown>;
  },
): Promise<{ ok: true; restoredIds: string[] } | { ok: false; error: string }> {
  const ids = args.members.map((m) => m.id);
  // Read BEFORE the restore: what each member's audit row reports (service,
  // prior reason, patient) is its deleted state, which the restore clears.
  const { data: before } = await admin
    .from("test_requests")
    .select("id, deleted_at, delete_reason, visits!inner ( patient_id ), services ( name, code )")
    .in("id", ids)
    .eq("visit_id", args.visitId);
  const infoOf = new Map((before ?? []).map((r) => [r.id, r]));

  const { error } = await withLifecycleRetry(() =>
    admin.rpc("restore_panel_members", {
      p_visit_id: args.visitId,
      p_test_request_ids: ids,
      p_deleted_at: args.members.map((m) => m.deletedAt),
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  for (const m of args.members) {
    const info = infoOf.get(m.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: info?.visits.patient_id ?? null,
      action: "test_request.restored",
      resource_type: "test_request",
      resource_id: m.id,
      metadata: {
        visit_id: args.visitId,
        reason: args.reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        prior_delete_reason: info?.delete_reason ?? null,
        prior_deleted_at: info?.deleted_at ?? m.deletedAt,
        bulk: args.members.length > 1,
        ...(args.auditExtra ?? {}),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }
  return { ok: true, restoredIds: ids };
}
```

(`services` may type as an object or array depending on the generated relationship; follow what `queue-restore-core.ts` does with `info?.services?.name` — it compiles there with the same select.)

- [ ] **Step 4: Run — expect PASS**, then typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/queue/panel-writes.ts src/lib/actions/queue/panel-writes.undo.test.ts
git commit -m "feat(queue): panel re-claim and restore helpers over the 0200 all-or-nothing functions"
```

### Task B3: `undoBulkQueueAction` uses the helpers; lifecycle retry on the single-row writes (items 2 + 5)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts` (the undo section, ~lines 600–1150)
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.undo-behaviour.test.ts`
- Modify: `src/lib/queue/partial-panel.ts` (+ test) — remove what becomes unused

- [ ] **Step 1: Update the behavioural tests first.** In `actions.undo-behaviour.test.ts`:
  - Add an `installReclaimRpc(db)` and `installRestoreRpc(db)` beside `installUnclaimRpc`, mirroring the SQL exactly: reclaim → every id `requested` + `assigned_to null` + `deleted_at null` + visit live, else `{ error: { code: "P0082", message: "Someone claimed or changed part of this report since — nothing was put back." } }` with NO row changed; otherwise set each row `in_progress` / its holder / `started_at ?? now`. Restore → every id on `p_visit_id`, `parent_id null`, `deleted_at` same instant as passed, visit live, else P0082 `"Part of this report was already restored or changed — nothing was restored."` with no change; otherwise clear the three columns. Make the combined `hooks.rpc` dispatch by `rec.fn` (keep the existing unclaim branch).
  - Every existing **panel reclaim** and **panel restore** case that asserted compensation (`PARTIAL_PANEL_LEFTOVER_REASON`, "compensated", `test_request.deleted` compensation rows, `partial_panel: true`) is rewritten to assert the new contract: a race that changes one member between the pre-check and the write (`hooks.beforeWrite` can't see RPCs — put the race inside the rpc hook: mutate one member, then apply the SQL rule) → the panel is in `notRestored` with the P0082 message, **every member unchanged**, **no** audit row for any member, `restoredTestCount` 0.
  - New cases: (a) panel reclaim happy path → exactly one `reclaim_panel_members` rpc call with each member's own holder and previous_started_at, members `in_progress` under their own holders, one `test_request.reassigned` audit row per member carrying `via: bulk_undo`, `undo_of_batch`, `panel_key`; (b) panel restore happy path → one `restore_panel_members` call per panel, members live, one `test_request.restored` row each; (c) single-row reclaim and single-row unclaim writes retry once on `P0072` (use `hooks.beforeWrite` returning `{ code: "P0072" }` the first time for `test_requests` updates) and succeed; a second P0072 is reported as not restored; (d) singles in a restore batch still go through `restoreTestRequestsForVisit` (assert on `db.updates("test_requests")` filters containing `deleted_at` — no rpc call for them).
  - Delete the `PARTIAL_PANEL_LEFTOVER_REASON` import if nothing uses it any more.

- [ ] **Step 2: Run — expect the new/rewritten cases to FAIL** against today's code.

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/queue/actions.undo-behaviour.test.ts"`

- [ ] **Step 3: Rewrite the reclaim branch** of `undoBulkQueueAction`. Keep everything up to and including the payment-gate check (`gateFailure`) unchanged. Replace from `const startedAtOf = new Map(...)` to the end of the group loop body with:

```ts
        const startedAtOf = new Map(steps.map((s) => [s.id, s.startedAt]));
        const auditExtra = {
          via: BULK_UNDO_VIA,
          undo_of_batch: parsed.data.batchId,
          bulk_batch_id: undoBatchId,
        };

        if (panel) {
          // A chemistry panel goes back through reclaim_panel_members (0200):
          // one statement, every member under its own holder or none (P0082)
          // — nothing to compensate, and a lost race changes nothing.
          const result = await reclaimPanelMembers(session, supabase, {
            members: ids.map((id) => ({ id, holder: holderOf.get(id)!, startedAt: startedAtOf.get(id) ?? null })),
            visitIdOf: (id) => steps.find((s) => s.id === id)?.visitId ?? null,
            auditExtra: { ...auditExtra, panel_key: steps[0]!.panelKey },
          });
          if (!result.ok) {
            notRestored.push({ id: group.key, reason: result.error });
            continue;
          }
          for (const id of ids) touchedTestPages.add(id);
          trackPanel(group.key);
          restoredIds.push(group.key);
          anyChanged = true;
          continue;
        }

        // A single test: one conditional write, retried once on a lost
        // lifecycle race (#263 parity) — a real commit rolls back whole, so
        // the retry can never double-write.
        const id = ids[0]!;
        const { data, error } = await withLifecycleRetry(() =>
          supabase
            .from("test_requests")
            .update({
              status: "in_progress",
              assigned_to: holderOf.get(id)!,
              started_at: startedAtOf.get(id) ?? new Date().toISOString(),
            })
            .eq("id", id)
            .eq("status", "requested")
            .is("assigned_to", null)
            .is("deleted_at", null)
            .select("id, visit_id")
            .maybeSingle(),
        );
        if (error || !data) {
          notRestored.push({ id: group.key, reason: RECLAIM_STATE_MOVED });
          continue;
        }
        await audit({
          actor_id: session.user_id,
          actor_type: "staff",
          action: "test_request.reassigned",
          resource_type: "test_request",
          resource_id: data.id,
          metadata: { visit_id: data.visit_id, from: null, to: holderOf.get(data.id) ?? null, ...auditExtra },
          ip_address: ip,
          user_agent: ua,
        });
        touchedTestPages.add(data.id);
        restoredIds.push(group.key);
        anyChanged = true;
```

(`ip`, `ua`, `undoBatchId`, `holderOf`, `ids`, `steps`, `panel` are already in scope in that branch. Import `reclaimPanelMembers` and `restorePanelMembers` from `@/lib/actions/queue/panel-writes`.)

- [ ] **Step 4: Wrap the single-row unclaim write** in the `kind === "unclaim"` branch:

```ts
        const { data, error } = await withLifecycleRetry(() =>
          supabase
            .from("test_requests")
            .update({ status: "requested", assigned_to: null, started_at: null })
            .in("id", ids)
            .eq("status", "in_progress")
            .eq("assigned_to", session.user_id)
            .eq("started_at", startedAtValue)
            .is("deleted_at", null)
            .select("id, visit_id"),
        );
```

- [ ] **Step 5: Rewrite the restore branch.** Keep the pre-validation read (`currentRead`) and the per-group `changed` / `stale` checks exactly. Then split valid groups:

```ts
      const restoredTestIds = new Set<string>();
      const singleIdsByVisit = new Map<string, string[]>();
      const panelGroups: typeof restoreGroups = [];
      for (const group of restoreGroups) {
        if (!validGroupKeys.has(group.key)) continue;
        if (group.steps[0]!.panelKey !== null) {
          panelGroups.push(group);
          continue;
        }
        for (const s of group.steps) {
          const list = singleIdsByVisit.get(s.visitId) ?? [];
          list.push(s.id);
          singleIdsByVisit.set(s.visitId, list);
        }
      }

      // Singles: one row each, so restoreTestRequestsForVisit's per-row
      // exact-deleted_at write is already all-or-nothing per row.
      for (const [visitId, ids] of singleIdsByVisit) {
        const outcome = await restoreTestRequestsForVisit(
          session, visitId, ids, "Undo of a bulk delete",
          { via: BULK_UNDO_VIA, undo_of_batch: parsed.data.batchId, bulk_batch_id: undoBatchId },
          expectedDeletedAtOf,
        );
        if (outcome.ok) for (const id of outcome.restoredIds) restoredTestIds.add(id);
      }

      // Panels: restore_panel_members (0200) — one statement per panel, every
      // member or none (P0082). Same active-patient rule as a single Restore.
      const panelReasonOf = new Map<string, string>();
      for (const group of panelGroups) {
        const visitId = group.steps[0]!.visitId;
        const active = await assertVisitPatientActive(admin, visitId);
        if (!active.ok) {
          panelReasonOf.set(group.key, active.error);
          continue;
        }
        const result = await restorePanelMembers(session, admin, {
          visitId,
          members: group.steps.map((s) => ({ id: s.id, deletedAt: s.deletedAt! })),
          reason: "Undo of a bulk delete",
          auditExtra: {
            via: BULK_UNDO_VIA,
            undo_of_batch: parsed.data.batchId,
            bulk_batch_id: undoBatchId,
            panel_key: group.key,
          },
        });
        if (!result.ok) {
          panelReasonOf.set(group.key, result.error);
          continue;
        }
        for (const id of result.restoredIds) restoredTestIds.add(id);
        revalidateQueueSurfaces(visitId);
      }

      if (restoredTestIds.size > 0) anyChanged = true;
      for (const group of restoreGroups) {
        if (!validGroupKeys.has(group.key)) continue; // already reported above
        const ids = group.steps.map((s) => s.id);
        if (ids.every((id) => restoredTestIds.has(id))) {
          if (group.steps[0]!.panelKey !== null) trackPanel(group.key);
          restoredIds.push(group.key);
        } else {
          notRestored.push({ id: group.key, reason: panelReasonOf.get(group.key) ?? RESTORE_PANEL_CHANGED });
        }
      }
```

Delete the old `idsByVisit` loop, the whole compensation block (`compensationReasonOf`, `partiallyRestoredIds`, the re-delete writes) and `priorOf` if nothing else reads it; drop `deleted_by, delete_reason` from `currentRead`'s select only if `priorOf` is gone. Import `assertVisitPatientActive` from `@/lib/patients/require-active` (the test file already mocks it).

- [ ] **Step 6: Remove dead code** — delete `auditLeftoverPanelRows` if unused; in `src/lib/queue/partial-panel.ts` delete `stillCommittedRows`, `partiallyRestoredIds` and `PARTIAL_PANEL_LEFTOVER_REASON` only if `grep -rn` shows no other importer (keep `groupIdsByDeletedAt` — queue-restore-core uses it), and remove their tests. Update the header comment of the undo section (lines ~600–625) to say reclaim and restore of a panel are atomic in the database (0200) and nothing is compensated any more.

- [ ] **Step 7: Run the queue + panel tests, typecheck, lint**

Run: `npx vitest run "src/app/(staff)/staff/(dashboard)/queue" src/lib/actions/queue src/lib/queue src/lib/patients/write-guards.test.ts src/lib/visits/query-surfaces.test.ts && npm run -s typecheck && npm run -s lint`
Expected: PASS. If `query-surfaces.test.ts` flags a new read, register it the way the file asks (read its failure message).

- [ ] **Step 8: Commit**

```bash
git add -A "src/app/(staff)/staff/(dashboard)/queue" src/lib/queue src/lib/actions/queue
git commit -m "feat(queue): panel Undo of a bulk Unclaim or Delete is one all-or-nothing step (0200); single-row Undo writes retry a lost lifecycle race"
```

### Task B4: Appointments Undo write in `withLifecycleRetry` (item 5)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/actions.ts:1004-1010`
- Test: the appointments Undo tests (find them: `grep -rln "undoBulkAppointmentsAction" src --include=*.test.*` — use `grep -rl … src | grep test` under zsh)

- [ ] **Step 1: Write the failing test** — in the existing appointments undo test file (or a new `appointments/actions.undo-retry.test.ts` using FakeDb with the same mocks as `actions.bulk.test.ts` in PR A, plus `@/lib/patients/require-active` mocked to allow): seed one `appointments` row `cancelled`, one audit row `appointment.cancelled` with `previous_status: "confirmed"` and the batch id; `hooks.beforeWrite` returns `{ code: "P0072", message: "moved" }` on the FIRST `appointments` update only. Expect `{ ok: true, restoredIds: [id], notRestored: [] }` and the row `confirmed`. A second case where it returns P0072 twice → the booking is in `notRestored` with `could not be undone just now — try again`.

- [ ] **Step 2: Run — expect FAIL** (today the first P0072 is reported, no retry)

- [ ] **Step 3: Implement** — wrap the bucket write:

```ts
      // Retried once on a lost lifecycle race (P0072/40P01/40001 — #263
      // parity): the chunk is one UPDATE that rolls back whole on a loss.
      const { data, error } = await withLifecycleRetry(() =>
        supabase
          .from("appointments")
          .update({ status: bucket.restoreTo })
          .in("id", part)
          .eq("status", bucket.current)
          .select("id, patient_id"),
      );
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments"
git commit -m "fix(appointments): bulk Undo retries a write that lost a patient lifecycle race"
```

### Task B5: Two-session concurrency proof for 0200 — **run at `--effort high`**

Before dispatching: ask the owner to switch to `/effort high` (their instruction). Read `.claude/skills/drmed-migrations/SKILL.md` "Proving a migration under concurrency" and `scripts/panel-claim-concurrency-proof.ts` in full first; the new runner copies that harness (guard, advisory lock, tagged committed fixtures, actors, `mustWait`/`mustNotWait` on `pg_locks`, `andEnd`, two plan modes, `--control` mutants in a throwaway schema, sweep + teardown count) and changes only the fixtures' starting state and the scenarios.

**Files:**
- Create: `scripts/panel-undo-concurrency-proof.ts`
- Modify: `package.json` scripts: `"panel-undo:concurrency-proof": "tsx scripts/panel-undo-concurrency-proof.ts"`

- [ ] **Step 1: Header + harness.** Tag prefix `puc-<hex>`; advisory lock `hashtext('panel-undo:concurrency-proof')`; refuse any non-localhost DB URL; `requireLocalOrExplicitProd("panel-undo:concurrency-proof", …)`. Actors: staff sessions as `authenticated` (reclaim) and a `service_role` session (restore — `set local role service_role`, no JWT sub needed). Fixtures: five staff (admin, two medtechs, a reception, an x-ray tech), three chemistry services in one report group, one patient, three visits (panels P, Q, R of three tests). Actions issued exactly as the app does: `select public.reclaim_panel_members($1::uuid[], $2::uuid[], $3::timestamptz[])`, `select public.restore_panel_members($1, $2::uuid[], $3::timestamptz[])`, and the competing writers copied verbatim from the app (`claim_panel_members`, the single `claimTestAction` UPDATE, `unclaim_panel_members`, the queue delete UPDATE the proof file already has as `queueDelete`, the manual Restore UPDATE from `restoreTestRequestsForVisit`'s non-bulk branch: `update test_requests set deleted_at=null, deleted_by=null, delete_reason=null where id = any($1) and visit_id=$2 and deleted_at is not null`).

- [ ] **Step 2: Forced scenarios** (each in both plan modes; every one asserts committed state from the monitor connection and that NO member is left half-changed):
  - **R1** single claim of one member commits first, panel reclaim queued → reclaim P0082, the other two members still requested/unassigned, the claimed one under the claimer.
  - **R2** single claim of one member rolls back, reclaim queued → reclaim lands whole: each member under its own holder with its own started_at.
  - **R3** reclaim first, `claim_panel_members` queued → claim P0077, panel whole under the reclaimed holders.
  - **R4** queue delete of one member first, reclaim queued → reclaim P0082, nothing reclaimed.
  - **R5** two reclaims of the same panel (double Undo click from two tabs), released together → exactly one lands, the other P0082.
  - **R6** two reclaims of P+Q vs Q+P (opposite member order) released together → no `40P01`; one wins per panel; check the plan shape first as `assertLockOrderIndependentOfArray` does.
  - **S1** manual Restore of one member commits first, panel restore queued → restore P0082, the other two still deleted at their original `deleted_at`.
  - **S2** manual Restore rolls back → panel restore lands whole.
  - **S3** two panel restores released together → one lands, the other P0082.
  - **S4** restore-then-re-delete of one member (new `deleted_at`) commits first → panel restore P0082 (exact `deleted_at` predicate).
  - **S5** visit soft-delete commits first (`update visits set deleted_at=now(), deleted_by=…, delete_reason='t' where id=$1` — the fixture visit is unpaid so the 0125 guard allows it) → panel restore P0082 with the visit message.
- [ ] **Step 3: Free races** (`PUC_ROUNDS`, default 25): F1 reclaim vs a three-way single-claim race on one panel → never split (all three under reclaimed holders, or the reclaim refused and at most the racers' claims present, each member exactly one holder); F2 restore vs manual restore of a random member → panel either fully restored or restore refused with no member restored by the panel call.
- [ ] **Step 4: `--control` mutants** (throwaway schema `puc_ctl_<hex>`, never `public`): A — reclaim without the row-count check (R1/R4 must FAIL: a split panel); B — reclaim without `t.status = 'requested'` (R3/R5 must FAIL); C — restore without the row-count check (S1/S4 must FAIL); D — restore without `t.deleted_at = x.deleted_at` (S4 must FAIL). The run passes only when every named scenario fails for its mutant in both modes. The mutant's `from` text must be found or the script throws.
- [ ] **Step 5: Prod plan shape (read-only).** Through MCP `execute_sql` on project `qhptbmafrosgibooelpp` (DRMed — never `zzcbzeivzfwwmotzlkqw`), `explain (costs off)` of both UPDATE statements with literal arrays (never `analyze`), BEFORE 0200 exists there — explain the UPDATE text itself, not the function call. Set the "indexed" mode's GUCs to reproduce that shape; print both modes' local plans at startup.
- [ ] **Step 6: Run**

```bash
npm run panel-undo:concurrency-proof > "$SCRATCH/puc.log" 2>&1; tail -20 "$SCRATCH/puc.log"
npm run panel-undo:concurrency-proof -- --control > "$SCRATCH/puc-ctl.log" 2>&1; tail -20 "$SCRATCH/puc-ctl.log"
```

Expected: `N/N passed` both times, teardown reports 0 tagged rows left. A FAIL on the real functions is a real bug → fix forward in 0200 (not yet on prod), re-run smoke + proof.

- [ ] **Step 7: Commit**

```bash
git add scripts/panel-undo-concurrency-proof.ts package.json
git commit -m "test(db): two-session concurrency proof for 0200's panel re-claim and restore, with control mutants"
```

### Task B6: Undo for the panel row's own Claim button (item 3)

**Design:** the queue row's panel Claim (`claimPanelAction`) now mints a batch id server-side and writes per-member audit rows (the `PanelBatchAudit` shape the bulk Claim already uses), so the existing `undoBulkQueueAction` can reverse it through `unclaim_panel_members`. The button navigates to the report page (unchanged) with `?claimed=<batch>&at=<ms>`; that page shows the shared outcome panel with ↶ Undo for 10 minutes. The batch id in the URL is safe: Undo re-proves actor, window and state server-side, exactly as for the bars.

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/panel-actions.ts` (`claimPanelAction`)
- Modify: `src/app/(staff)/staff/(dashboard)/queue/panel-actions.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/claim-button.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/claim-undo-notice.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/claim-undo-notice.test.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx`

- [ ] **Step 1: Failing test for the action** — in `panel-actions.test.ts`, following its existing `claimPanelAction` cases: a successful claim returns `{ ok: true, batchId: <uuid> }`; the audit rows are one per bench member with `bulk_batch_id` = that id, `bulk_batch_size: 1`, `panel_key: panelRowKey(visit, group)`, `visit_id`, `started_at`; the input schema still rejects any extra `batchId` field the browser might send (`PanelSchema` is `z.object` — assert a supplied `batchId` is ignored: the returned id differs from it).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — `PanelOutcome` gains an optional batch id on success; in `panel-writes.ts`:

```ts
export type PanelOutcome = { ok: true; batchId?: string } | { ok: false; error: string };
```

and in `claimPanelAction`, replace the `claimPanelMembers` call:

```ts
  // One-panel "bulk" batch, minted here (never from the input), so the
  // report page can offer the bar's 10-minute Undo for this claim too.
  const key = panelRowKey(parsed.data.visitId, parsed.data.groupId);
  const batchId = crypto.randomUUID();
  const result = await claimPanelMembers(
    session,
    supabase,
    state.benchIds,
    { visit_id: parsed.data.visitId, report_group_id: parsed.data.groupId },
    { batchId, batchSize: 1, panelKey: key, visitId: parsed.data.visitId },
  );
  if (!result.ok) return result;
  revalidatePath("/staff/queue");
  return { ok: true, batchId };
```

(Reuse the `key` for the `resolved.states.get(...)` lookup above it.)

- [ ] **Step 4: Run — expect PASS**; also run `src/lib/actions/queue/bulk-cores.test.ts` (it references `claimPanelAction`).

- [ ] **Step 5: ClaimButton** — in the success branch for a panel with `navigateOnClaim`:

```tsx
            router.push(
              panel
                ? `/staff/queue/consolidated/${panel.visitId}/${panel.groupId}` +
                    ("batchId" in result && result.batchId
                      ? `?claimed=${encodeURIComponent(result.batchId)}&at=${Date.now()}`
                      : "")
                : `/staff/queue/${testRequestId}`,
            );
```

- [ ] **Step 6: Failing jsdom test for the notice** — `claim-undo-notice.test.tsx` (mock `next/navigation` `useRouter`/`usePathname` and `../../../actions`' `undoBulkQueueAction`):
  - renders `You claimed Chemistry.` and a `↶ Undo` button when `doneAt` is recent;
  - no `↶ Undo` when `doneAt` is 11 minutes ago;
  - clicking Undo calls `undoBulkQueueAction({ batchId })`; on `{ ok: true, restoredIds: [key], restoredTestCount: 3, notRestored: [] }` shows `Undone — Chemistry is back in the queue, unclaimed.`, hides Undo and calls `router.refresh()`;
  - on `{ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: key, reason: "claimed work has moved on — a result was uploaded or someone else holds it" }] }` shows `Not undone — claimed work has moved on — …` and hides Undo;
  - on `{ ok: false, error: UNDO_EXPIRED }` shows the error and hides Undo; on another error keeps Undo (retry);
  - Dismiss calls `router.replace(pathname)` (drops the query string).

- [ ] **Step 7: Implement the notice** — `claim-undo-notice.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";
import { undoBulkQueueAction } from "../../../actions";

// Shown on a report page right after the queue row's panel Claim sent the
// operator here (?claimed=<batch>&at=<ms>): the same 10-minute ↶ Undo the
// bulk bar offers, over the same server action — which re-proves actor,
// window and state, so the batch id in the URL grants nothing by itself.
export function ClaimUndoNotice({
  batchId,
  doneAt,
  reportName,
}: {
  batchId: string;
  doneAt: number;
  reportName: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState(`You claimed ${reportName}.`);
  const [undoable, setUndoable] = useState(true);

  function onUndo() {
    if (pending) return;
    start(async () => {
      const r = await undoBulkQueueAction({ batchId });
      if (!r.ok) {
        setMessage(r.error);
        if (r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY) setUndoable(false);
        return;
      }
      setUndoable(false);
      if (r.restoredIds.length > 0) {
        setMessage(`Undone — ${reportName} is back in the queue, unclaimed.`);
        router.refresh();
      } else {
        setMessage(`Not undone — ${r.notRestored[0]?.reason ?? "it changed since"}.`);
      }
    });
  }

  return (
    <BulkOutcomePanel
      message={message}
      undo={undoable ? { doneAt, windowMs: UNDO_WINDOW_MS, pending, onUndo } : null}
      onDismiss={() => router.replace(pathname)}
    />
  );
}
```

(Adjust the relative import to wherever `undoBulkQueueAction` resolves from this folder: `src/app/(staff)/staff/(dashboard)/queue/actions.ts`.)

- [ ] **Step 8: Page** — `consolidated/[visitId]/[groupId]/page.tsx`: widen `searchParams` to `Promise<{ edit?: string | string[]; claimed?: string | string[]; at?: string | string[] }>`; read once (`const sp = await searchParams;`), and compute:

```tsx
  // ?claimed=<batch>&at=<ms> — set by the queue row's panel Claim (item 3).
  const claimedParam = typeof sp.claimed === "string" && /^[0-9a-f-]{36}$/i.test(sp.claimed) ? sp.claimed : null;
  const atParam = typeof sp.at === "string" ? Number(sp.at) : NaN;
  const claimedAt = Number.isFinite(atParam) && atParam <= Date.now() ? atParam : Date.now();
```

and render `{claimedParam ? <ClaimUndoNotice batchId={claimedParam} doneAt={claimedAt} reportName={group.name} /> : null}` once, at the end of the page's returned tree (the panel pins itself to the bottom via `FixedBottomBar`). Keep the `edit` handling reading from `sp`.

- [ ] **Step 9: Run** the notice test, the queue tests, typecheck, lint — expect PASS.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue" src/lib/actions/queue/panel-writes.ts
git commit -m "feat(queue): 10-minute Undo for a chemistry panel's own Claim button"
```

### Task B7: Browser checks, guide, gates, prod migration, PR

**Files:**
- Modify: `scripts/browser-check/bulk-select.ts` (`sectionPanelUndo`)
- Modify: `docs/drmed-user-guide.html` (the Lab queue section's Undo paragraph — `grep -n "Undo" docs/drmed-user-guide.html` near the lab-queue bulk text)

- [ ] **Step 1: Browser checks** — extend `sectionPanelUndo` (read PU1–PU3 first; same fixtures, visit 9107 panel) with:
  - **PU4** admin bulk-Unclaims a panel held by the medtech → ↶ Undo → every member `in_progress` under the medtech with its ORIGINAL `started_at` (DB), one `reclaim_panel_members`-era `test_request.reassigned` row per member with `via = bulk_undo`.
  - **PU5** same, but before Undo claim ONE member in the DB as another medtech (`update test_requests set status='in_progress', assigned_to=<other>, started_at=now() where id=<m1>`) → Undo outcome names the panel with `Someone claimed or changed part of this report since — nothing was put back.`; the other two members still `requested`/unassigned (nothing half-reclaimed).
  - **PU6** admin bulk-Deletes the panel (reason) → ↶ Undo → every member live again; one `test_request.restored` row per member.
  - **PU7** same, but restore ONE member in the DB first → Undo names the panel with `Part of this report was already restored or changed — nothing was restored.`; the other two still deleted at their original `deleted_at`.
  - **PC1** medtech clicks the queue row's panel `Claim` → lands on `/staff/queue/consolidated/…?claimed=…&at=…`; the bottom panel reads `You claimed <name>.` with `↶ Undo`.
  - **PC2** ↶ Undo → `Undone — <name> is back in the queue, unclaimed.`; DB: members `requested`/unassigned; the queue list shows the panel's Claim again.
  - **PC3** claim again, then have admin (other page) claim-release nothing but reassign one member in the DB → ↶ Undo → `Not undone — …`; no member changed.
- [ ] **Step 2: Run on a quiet machine** (limiter cleared, no vitest; local stack has 0200 applied from Task B1): `npm run check:bulk-select` → all PASS; record the count.
- [ ] **Step 3: Guide** — in the Lab queue Undo paragraph, add: a chemistry panel's Undo after a bulk Unclaim or Delete puts back all of its tests or none of them, and names the panel when it can't; and that the panel row's own **Claim** opens the report with the same 10-minute ↶ Undo at the bottom. Content only — version at merge.
- [ ] **Step 4: Gates** — `npm test` (log to scratchpad, tail), `npm run -s typecheck`, `npm run -s lint`, the smoke SQL again, the proof again (plain + `--control`). All green.
- [ ] **Step 5: Whole-branch review** — Sonnet `superpowers:code-reviewer` over `git diff origin/main...HEAD` against this plan's PR B section; fix confirmed findings.
- [ ] **Step 6: Prod migration — dry-run first, then apply yourself** (memory `feedback-drmed-apply-migrations-yourself`: never ask; dry-run first). Right before merging:
  1. `git fetch` + `npm run claim -- list` + MCP `list_migrations` on `qhptbmafrosgibooelpp`: confirm 0200 is the only pending local migration and nobody took 0200 on prod.
  2. Copy `supabase/.temp/{project-ref,linked-project.json,pooler-url}` from the main checkout into this worktree if `supabase db push` needs the link.
  3. Dry run: `/opt/homebrew/bin/supabase db push --dry-run` → must list exactly `0200_panel_undo_all_or_nothing.sql`. (If prod holds a migration the branch lacks — e.g. 0198 from the atomic-release PR — copy that file in untracked for the push, as memory records for 0184; never commit it here.)
  4. Apply: `/opt/homebrew/bin/supabase db push` (if the auto-mode classifier blocks it, fall back to asking the owner to run `! cd ~/Claude/DRMed/.worktrees/queue-undo-atomic && /opt/homebrew/bin/supabase db push`).
  5. Verify by object via MCP `execute_sql` (read-only): both functions exist with the expected signatures; `has_function_privilege` matches the smoke test's ACL assertions for `anon`, `authenticated`, `service_role`; the ledger row `0200` exists.
- [ ] **Step 7: Push, open PR** `feat(queue): panel Undo in one all-or-nothing step (0200) + Undo for a panel's own Claim`. Body: summary, proof command + `N/N` + both plan shapes, smoke result, browser count, "0200 applied to prod <time>, verified by object". Stop for the owner's merge OK; at merge: merge main, bump the guide version (four markers), push, merge, confirm the Vercel deploy.

---

# PR C — Queue bulk Release Undo (items 4, 6, 7) — plan after `feat/atomic-report-release` merges

Not tasked here on purpose (see "Why C waits"). Locked intent, to be turned into tasks with writing-plans against the post-0198 code:

- **Item 4:** `releaseTestsAction` mints ONE batch id per call on the server and passes it to every `releaseVisitSelection(..., bulkBatchId)` (or whatever 0198 renames it to), the way the visit page's `releaseSelectedAction` does; it returns `batchId` when anything was released. `QueueBulkBar` shows ↶ Undo for 10 minutes and calls `undoReleaseBatchAction` — reusing its rules unchanged: same actor, 10 minutes, whole combined reports only, exact `released_at`, the "patient was already notified" line driven by `notifiedCount`, automatic unrelease reason "Undone within 10 minutes of release", all release surfaces revalidated. Role: the lab roles that can release from the Queue.
- **Item 6:** when a release Undo refuses a combined report because one of its members was released separately (its release audit row is outside this batch), the refusal names that instead of the generic `CHANGED_SINCE_REASON` — wording to agree with the owner, e.g. "part of this report was released separately — undo it from the report page".
- **Item 7:** a behavioural test that runs `undoReleaseBatchAction` end to end on a combined report through `src/lib/actions/visits/fake-release-db.ts` (as rewritten by 0198): report-mates inside the batch undone together; a mate released outside the batch refuses the whole report with item 6's reason; expiry, other actor and already-undone refusals.
- Browser: a Queue bulk Release → ↶ Undo check (V-series in `check:bulk-select`), Email and Physical media.

---

## Also worth considering (owner to prune — not in any PR above)

**Cheap**
- Undo for a **single test's** own Claim button on the queue (same `?claimed=` notice on the bench page) — PR B makes it a small follow-on.
- Undo for the report page's own **Claim** (`claimConsolidated`) — same notice, same action.
- The single-message status action (`updateMessageStatusAction`) reads then writes by id alone — give it the same `eq("status", …)` guard the bulk action has, so a message booked between opening and clicking is not overwritten.
- Website Messages bar: a **Mark corporate lead** bulk toggle (kind), reusing the same batch/Undo shape.

**Medium**
- Website Messages: **bulk reply templates** ("We received your message…") over the selection — needs a per-message send loop with the existing reply history and RA 10173 audit rules.
- Admin audit filter: a "Website Messages bulk changes" preset (bulk_batch_size > 1, resource_type contact_message) beside the existing bulk filter.
- Inbox → Appointments shortcut: after bulk-marking messages replied, a "Book the first one" link.

**Larger**
- A vitest guard that fails when a migration adds a claim/lock/all-or-nothing function without a matching `scripts/*-concurrency-proof.ts` (already on the lab-release follow-up list — PR B would be its second customer).
- Migrating the visit page's Tests bar and the three HMO bars onto one shared Undo-outcome hook (they each re-implement the Outcome/undo state machine the Appointments, Queue and Messages bars now share).
