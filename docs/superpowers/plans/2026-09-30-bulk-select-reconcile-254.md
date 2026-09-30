# Bulk-select follow-ups × #254 reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge origin/main (which now has #254's whole-panel Claim / Unclaim / Delete on the lab queue, migration 0191) into `feat/bulk-select-followups`. #254's panel path is the single panel implementation. This branch's own duplicate panel code is dropped, and its 10-minute server-checked Undo is rebuilt on top of #254 so panel rows get Undo too.

**Owner decision (2026-09-30):** "Main wins, re-layer Undo". Don't add a migration to this PR. Don't run another Codex pass.

**Architecture:**
- Every bulk entry point mints ONE `bulk_batch_id` on the server and threads it through plain (non-`"use server"`) cores into every audit row it writes. The batch id is never taken from the browser.
- Panel members get per-member audit rows carrying `panel_key = panelRowKey(visitId, groupId)` plus the exact state the write produced: `started_at` for a claim, `previous_assignee`/`previous_started_at` for an unclaim, `deleted_at` for a delete.
- `undoBulkQueueAction` keeps its three branches. Panel un-claim now goes through `unclaim_panel_members` (atomic, 0191), so the compensating writes for that branch go away. Reclaim and restore keep today's exact-predicate + compensation code, since no RPC fits them without a migration.

**Tech Stack:** Next.js 16 server actions, Supabase/PostgREST, zod, vitest (node + jsdom), Playwright headless checklist (`npm run check:bulk-select`).

**Branch/worktree:** `~/Claude/DRMed/.worktrees/bulk-select-followups`, branch `feat/bulk-select-followups`, starting HEAD `ff7f1934`. origin/main = `2592f9f5`.

**Standing rules for every task:**
- zsh sandbox: never name a variable `path`.
- Localhost/DB access needs `dangerouslyDisableSandbox`.
- Never `db reset`. Local migrations: `supabase migration up --local --include-all` (with `export PATH="/opt/homebrew/bin:$PATH"`).
- Commit only in this worktree, with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Never `git stash` bare.

---

## File map (after the merge)

| File | Owner after reconcile | Change |
|---|---|---|
| `src/lib/queue/panel-members.ts` | main | take main's verbatim |
| `src/lib/queue/bulk-queue.ts` (+test) | main + branch | main's `panelRowKey`/`parsePanelRowKey`/`rowTestCount`/`sentTestCount`/`bulkQueueMessage`; keep branch's `batchId?` on `BulkQueueResult`; drop branch's `panelKey`/`parsePanelKey`/`splitQueueKeys`/`PanelRef` (main's `PanelRef` lives in panel-members.ts) |
| `src/lib/actions/queue/panel-writes.ts` | main | + batch/panel audit options (Task 3) |
| `src/lib/actions/queue/bulk-cores.ts` | NEW | single-test bulk claim / unclaim / delete cores taking a batch context (Task 2) |
| `src/app/(staff)/staff/(dashboard)/queue/panel-actions.ts` | main | mint one batch id per call, pass to cores + panel writes, return `batchId` (Task 3) |
| `src/app/(staff)/staff/(dashboard)/queue/actions.ts` | branch minus panel loops, plus main's `performUnclaim` (`seenHolders`, `unclaimPanelMembers` group path, `holders` in `QueueUnclaimSchema`) | Task 1, then Task 2 moves bulk bodies into cores |
| `src/lib/actions/visits/queue-deletion.ts` | branch minus `panels` in `ManyDeleteSchema` | Task 1, Task 2 |
| `queue/page.tsx`, `queue/queue-bulk-bar.tsx` | main's panel row/checkbox/wire/counts + branch's Undo/outcome/`selectionEdits` wiring | Task 1, Task 4 |
| `src/lib/ui/bulk-undo.ts`, `src/lib/audit/bulk-batch.ts`, `src/lib/queue/partial-panel.ts`, `src/lib/actions/visits/queue-restore-core.ts` | branch | unchanged except Task 5 |
| `scripts/browser-check/bulk-select.ts`, `scripts/seed/bulk-select-fixtures.sql` | branch | Task 6 |

---

### Task 1: Merge origin/main, main's panel path wins (no panel Undo yet)

**Files:** every conflicted file listed by `git merge origin/main`: CLAUDE.md, docs/drmed-user-guide.html, queue/actions.ts, queue/page.tsx, queue/queue-bulk-bar.tsx, src/lib/patients/write-guards.test.ts, src/lib/queue/bulk-queue.test.ts, src/lib/queue/panel-members.ts (add/add), plus non-conflicted files that reference dropped branch symbols.

- [ ] **Step 1: Start the merge.** Run `git merge --no-edit origin/main`. Expected: 8 conflicts (the list above).
- [ ] **Step 2: Resolve each file by these rules.**
  - `panel-members.ts`: `git checkout --theirs src/lib/queue/panel-members.ts`.
  - `bulk-queue.ts`/`bulk-queue.test.ts`: main's content, plus the branch's `batchId?: string` on the ok arm of `BulkQueueResult`, plus any branch-only non-panel helpers and tests. Delete the branch's `panelKey`, `parsePanelKey`, `splitQueueKeys` and `PanelRef`, along with their tests.
  - `queue/actions.ts`: keep the branch's version. Then:
    - (a) delete the panel loops/branches inside `claimTestsAction` and `unclaimTestsAction`: the `panels` schema fields, `loadPanelMembers` usage, and panel compensation;
    - (b) apply main's `performUnclaim` changes (`seenHolders` param, multi-id path via `unclaimPanelMembers`, `holders` in `QueueUnclaimSchema` + `unclaimFromQueueAction` building the map);
    - (c) keep `auditLeftoverPanelRows` only if something still calls it after (a) — the Undo reclaim branch does (Task 5); otherwise delete it;
    - (d) keep `undoBulkQueueAction` intact.
  - `queue-deletion.ts` (may auto-merge): remove the branch's `panels` field from `ManyDeleteSchema` and its panel resolve/compensation block (it used the branch's `loadPanelMembers`).
  - `page.tsx`: main's panel row, checkbox, weight (`state.allIds.length`) and `rowsByKey` fields; delete the branch's `panelTotals`/`panelKinds`/"N tests in this panel — M on another page" block. Keep every branch change unrelated to panels.
  - `queue-bulk-bar.tsx`: main's `splitKeys`, calls to `claimQueueSelectionAction` / `unclaimQueueSelectionAction` / `deleteQueueSelectionAction`, and test-count labels. Keep the branch's `Outcome`/`OutcomeUndo`, `runUndo`, `undoProp`, `done(...)` with `doneAt`, `selectionEdits` rule, and the `BulkOutcomePanel` usage. The Undo button must appear whenever a result carries `batchId` and `changedIds.length > 0`; the message comes from main's `bulkQueueMessage`.
  - `write-guards.test.ts`: union of both sides' entries.
  - `CLAUDE.md`: main's text, plus the branch's "bump the guide version only at merge time" wording. Keep main's migration-ledger lines.
  - `docs/drmed-user-guide.html`: union of content. Version stays main's (bump happens at merge time only).
- [ ] **Step 3: Remove the branch's panel tests.** Delete the two describe blocks in `queue/queue-bulk-bar.test.tsx` that assert `claimTestsAction`/`unclaimTestsAction` get `panels`. Keep main's equivalents. Make the branch's Undo jsdom tests mock `claimQueueSelectionAction` (etc.) returning `{ ok: true, changedIds, skipped: [], batchId }`.
- [ ] **Step 4: Fix references.** Run `npx tsc --noEmit -p .` and fix every reference to dropped symbols. Expected at the end: 0 errors.
- [ ] **Step 5: Apply 0191 locally.** Run `supabase migration up --local --include-all`. Expected: "Applying migration 0191_claim_panel_members.sql".
- [ ] **Step 6: Run the gates.** Run `npm test`, `npm run typecheck`, `npm run lint`. Expected: all pass (lint: only the pre-existing booking.ts warning).
- [ ] **Step 7: Commit the merge.** Message: `Merge origin/main (#254) into feat/bulk-select-followups — #254's panel path wins`.

### Task 2: Plain bulk cores with a batch context

**Files:**
- Create: `src/lib/actions/queue/bulk-cores.ts` (starts with `import "server-only";`, NOT `"use server"`)
- Modify: `queue/actions.ts` (`claimTestsAction`, `unclaimTestsAction` become thin wrappers)
- Modify: `src/lib/actions/visits/queue-deletion.ts` (`deleteTestRequestsManyAction` becomes a thin wrapper)
- Test: `src/lib/actions/queue/bulk-cores.test.ts` (source pinning, style of `hmo-claims/actions.undo-reversal.test.ts`)

Why: `"use server"` exports are public endpoints. A batch id must never be a client-supplied input, so every function that accepts a batch id must live in a plain module.

- [ ] **Step 1: Define the shared type in bulk-cores.ts.**

```ts
import "server-only";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { createClient } from "@/lib/supabase/server";
import type { BulkQueueResult } from "@/lib/queue/bulk-queue";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** One bulk call's identity — minted server-side by the entry point, never read from input. */
export interface BulkBatchContext {
  batchId: string;
  /** rows in the whole selection (singles + panels), for audit only */
  batchSize: number;
}
```

- [ ] **Step 2: Move the bodies into the cores.** Move the post-parse, post-auth body of the (now single-test-only) `claimTestsAction` into `claimTestsCore(session, supabase, testIds: string[], ctx: BulkBatchContext): Promise<BulkQueueResult>`. It writes `bulk_batch_id: ctx.batchId` and `bulk_batch_size: ctx.batchSize` exactly where the old body used its local `batchId`, and returns `batchId: ctx.batchId` on the ok arm. Do the same for `unclaimTestsCore(session, supabase, { items, reason }, ctx)` and `deleteTestRequestsManyCore(session, { testRequestIds, reason }, ctx & { panelKey?: string })`. When `panelKey` is given, each `test_request.deleted` audit row also gets `panel_key: panelKey`. Keep each core's role/zod-independent refusals (role checks stay in the core so a direct core call can't skip them).
- [ ] **Step 3: Turn the exported actions into wrappers.** Each exported action keeps its zod parse + `requireActiveStaff` + role checks, mints `crypto.randomUUID()`, and calls its core with `{ batchId, batchSize: <rows in input> }`.
- [ ] **Step 4: Write pinning tests** in `bulk-cores.test.ts`. They assert that:
  - bulk-cores.ts has no `"use server"`;
  - each exported wrapper contains `crypto.randomUUID()` and no zod field named `batchId`/`bulk_batch_id`;
  - each core writes `bulk_batch_id: ctx.batchId`.
  Revert the wrapper change temporarily and confirm the tests fail.
- [ ] **Step 5: Run the checks.** `npx vitest run src/lib/actions src/lib/queue "src/app/(staff)/staff/(dashboard)/queue"` + `npx tsc --noEmit -p .` → pass.
- [ ] **Step 6: Commit.** `refactor(queue): bulk claim/unclaim/delete cores take a server-minted batch context`.

### Task 3: Batch id + exact state on #254's panel writes

**Files:**
- Modify: `src/lib/actions/queue/panel-writes.ts`, `queue/panel-actions.ts`
- Test: `src/lib/actions/queue/panel-writes.test.ts` (new, mocked supabase client — pattern: `src/lib/accounting/journal-entry.reverse.test.ts`; mock `next/headers` and `@/lib/audit/log`)

- [ ] **Step 1: Write the failing tests** for `claimPanelMembers` with a `batch` option:
  - it reads back `id, started_at` of the claimed members (`.in("id", ids).eq("assigned_to", session.user_id).eq("status","in_progress")`);
  - it writes ONE `test_request.claimed` audit row PER MEMBER with `resource_id: id` and metadata `{ visit_id, started_at, panel_key, bulk_batch_id, bulk_batch_size, grouped: true, report_group_id }`, and NOT the grouped `resource_id: null` row.
  Without `batch`, the existing single grouped row is unchanged (the panel page / row Claim).
  For `unclaimPanelMembers` with `batch` + `startedAtOf`, each per-member row adds `bulk_batch_id`, `panel_key`, `previous_started_at`.
- [ ] **Step 2: Implement.** Add an optional 5th param to `claimPanelMembers`:

```ts
export interface PanelBatchAudit {
  batchId: string;
  batchSize: number;
  panelKey: string;
  visitId: string;
}
// claimPanelMembers(session, supabase, testRequestIds, auditExtra = {}, batch?: PanelBatchAudit)
```

  After a successful RPC with `batch` set: read back `started_at` for the ids (a read failure must not lose the audit — write the rows with `started_at: null` and `outcome_unverified: true`; Undo then refuses them as changed, which is safe). Then audit one row per member as specified.
  `unclaimPanelMembers` args gain `batch?: PanelBatchAudit` and `startedAtOf?: (id: string) => string | null`, merged into each per-member row.
- [ ] **Step 3: Update `panel-actions.ts`.**
  - `claimQueueSelectionAction` / `unclaimQueueSelectionAction` / `deleteQueueSelectionAction`: mint `const batchId = crypto.randomUUID()` after auth; `const ctx = { batchId, batchSize: singles + panels }`; call the Task 2 cores instead of the exported single actions.
  - Pass `batch: { batchId, batchSize, panelKey: panel.key, visitId: panel.visitId }` to each panel write.
  - For unclaim, pre-read `id, started_at` of every panel's `benchIds` in one query (fail closed: on error skip that panel with `"Could not read the report — refresh the queue and try again."`) and pass `startedAtOf`.
  - Delete passes `panelKey: panel.key` to `deleteTestRequestsManyCore`.
  - Return `batchId` on the ok arm whenever `changedIds.length > 0`. `combineClaimResults` must carry it: add `batchId?` to its ok output (update bulk-queue.ts + its test).
  - `claimPanelAction` (single row button) is unchanged: no batch, no Undo.
- [ ] **Step 4: Run the checks.** Tests + `npx tsc --noEmit -p .` → pass.
- [ ] **Step 5: Commit.** `feat(queue): panel bulk writes carry the batch id and the exact state Undo needs`.

### Task 4: Bar shows Undo for panel actions

**Files:** `queue/queue-bulk-bar.tsx`, `queue/queue-bulk-bar.test.tsx`

- [ ] **Step 1: Write the failing jsdom test.** A selection with one panel row: Claim resolves `{ ok: true, changedIds: [3 ids], skipped: [], batchId }`, so "↶ Undo" is visible. Clicking it calls `undoBulkQueueAction({ batchId })`. Mirror the existing single-row Undo tests (307–427).
- [ ] **Step 2: Make it pass.** Adjust `done(...)`, which should already work if Task 1 kept the Undo wiring keyed on `result.batchId`.
- [ ] **Step 3: Run and commit.** Run the test; commit `test(queue): Undo is offered after a panel bulk action`.

### Task 5: Undo reverses panels through #254's writes

**Files:** `queue/actions.ts` (`undoBulkQueueAction`), `src/lib/ui/bulk-undo.ts` (only if `planQueueUndo` needs `grouped`/`report_group_id` awareness), `queue/actions.undo-followups.test.ts`

- [ ] **Step 1: Confirm `planQueueUndo` groups the new rows.** Check that it groups Task 3's per-member rows by `panel_key` with no change (it reads `metadata.panel_key`, `started_at`, `previous_assignee`, `previous_started_at`, `deleted_at`). Add a unit test in `bulk-undo.test.ts` using exactly Task 3's metadata shape: three claimed rows with the same `panel_key` produce ONE group of three `unclaim` steps.
- [ ] **Step 2: Rewrite the un-claim branch for panel groups** (group size > 1 with a `panelKey`):
  - pre-validate every member with one read: `status = 'in_progress'`, `assigned_to = session.user_id`, `sameInstant(started_at, step.startedAt)`, not in `changedSince`;
  - any failure → the whole panel goes to `notRestored`;
  - otherwise call `unclaimPanelMembers(session, supabase, { members: ids.map((id) => ({ id, holder: session.user_id })), visitIdOf: () => visitId, reason: "Undo of a bulk claim", selfService: session.role !== "admin", auditExtra: { via: BULK_UNDO_VIA, undo_of_batch: batchId, bulk_batch_id: undoBatchId, panel_key } })`. The RPC is all-or-nothing, so there is no compensation.
  - Single rows keep today's exact-predicate write.
- [ ] **Step 3: Leave reclaim and restore alone.** Keep the reclaim (undo of unclaim) and restore (undo of delete) branches as they are (exact predicates + compensation + `auditLeftoverPanelRows`). They already group by `panelKey`.
- [ ] **Step 4: Update the pinning tests.** Update `actions.undo-followups.test.ts`: remove assertions tied to deleted panel-claim compensation; add one that the un-claim branch calls `unclaimPanelMembers` for panel groups. Revert-prove the new assertion.
- [ ] **Step 5: Run and commit.** Run `npx vitest run src/lib/ui src/lib/queue "src/app/(staff)/staff/(dashboard)/queue"` + tsc; commit `feat(queue): panel Undo un-claims through unclaim_panel_members`.

### Task 6: Browser checklist against #254's UI

**Files:** `scripts/browser-check/bulk-select.ts`, `scripts/seed/bulk-select-fixtures.sql` (visits 9105/9106 are the panels; keep them)

- [ ] **Step 1: Rewrite P1–P3 against main's panel row.**
  - Read `queue/page.tsx` on the merged branch for the checkbox's aria-label and the row's test count.
  - P1: the panel row has a checkbox and the bar counts its tests.
  - P2: a split panel (`?size=` to push one member to page 2) → Claim claims every member (DB read-back).
  - P3: a panel with one member pre-claimed by admin → Claim refuses the panel and changes nothing (DB read-back).
- [ ] **Step 2: Add the panel Undo checks.** Each asserts via SQL:
  - PU1: panel Claim → ↶ Undo → every member `requested`, `assigned_to null`, and a `bulk_undo` audit row per member.
  - PU2: admin panel Unclaim of the medtech's panel → Undo → every member back `in_progress` under the medtech with the original `started_at`.
  - PU3: panel Delete (admin) → Undo → every member's `deleted_at` null.
- [ ] **Step 3: Run the checklist.** Clear the local login limiter first (`delete from rate_limit_attempts where bucket='staff_login' and identifier in ('ip:::1','email:admin@drmed.ph','email:inactive@drmed.ph')`), with the dev server on :3007 from this worktree, on a quiet machine (no parallel vitest). Run `npm run check:bulk-select`. Expected: all pass (30 minus old P1–P3, plus new P1–P3 and PU1–PU3). inactive@drmed.ph ends as an active medtech.
- [ ] **Step 4: Commit.** `test(bulk-select): panel checks + panel Undo checks against #254's queue`.

### Task 7: Gates, review, PR

- [ ] **Step 1: Run the gates.** `npm test && npm run typecheck && npm run lint`.
- [ ] **Step 2: Sonnet review.** Have a Sonnet code reviewer look at `git diff ff7f1934..HEAD` (read-only). Fix the Critical/Important findings it confirms.
- [ ] **Step 3: Update the user guide content** for panel Undo (no version bump).
- [ ] **Step 4: Push and open the PR** (no migration). The body lists the 10 items + extras + the Codex fixes + the #254 reconciliation, and ends with the Claude Code line. Stop for the owner's merge OK. Bump the guide version at merge time.

---

## Self-review notes
- Every owner rule is covered: main's panel path wins (Task 1), panel Undo is rebuilt on it (Tasks 3–5), no migration (the RPCs are 0191's, already on main), no further Codex pass (Task 7 uses a Sonnet review).
- Residual non-atomic paths, to state honestly in the PR: panel reclaim-Undo and restore-Undo remain conditional writes + compensation. A true transaction would need a new RPC (a follow-up candidate).
