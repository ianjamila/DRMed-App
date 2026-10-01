# Bulk-select PR C + extras — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Sonnet for every implementer and reviewer subagent, one task at a time** (owner rule). After each task: a spec review, then a quality review. A whole-branch review before each PR. Stop for the owner's merge OK on each PR.

**Goal:** Ship the eleven approved items of the bulk-select "PR C and extras" batch (owner request 2026-10-01, memory `drmed-bulk-row-selection`): a 10-minute Undo for the Queue's bulk Release with a distinct report-mate refusal and an end-to-end test, Claim Undo for the single-test and report-page Claim buttons, a stale-click guard on the single message status button, a bulk corporate-lead toggle with Undo, an audit-log preset, a shared Undo-outcome hook for every bulk bar, a lock-race retry on manual Restore, and four small cleanups.

**Architecture:** Every Undo reuses the existing shared kit — a server-minted `bulk_batch_id` on every audit row, `loadOwnBatchRows` (`src/lib/audit/bulk-batch.ts`) for the same-actor / 10-minute / already-undone rules and the `changedSince` guard, exact-predicate reverse writes, and `BulkOutcomePanel` for the ↶ Undo button. Release Undo stays on `undo_visit_release` (0198/0205/0214) through `undoReleasedRows`; nothing in this batch changes a database function, so **no migration** is planned (item 11's `reclaim_panel_members` grant cleanup is therefore deferred, as the owner directed).

**Tech Stack:** Next.js 16 server actions, Supabase (Postgres 17, PostgREST), zod, Vitest (Node + jsdom), `npm run check:bulk-select` (headless Chrome, local stack, dev server :3007).

---

## Read this first (facts re-read from main @ 3456a346, 2026-10-01)

- **Release is a database function now.** `releaseVisitSelection` (`src/lib/actions/visits/release-reports.ts`) calls `release_visit_results`; the database writes one `test_request.released` audit row per released line (0205) with `visit_id`, `release_medium`, `released_at` (full microseconds) and every `p_audit.metadata` extra — so `bulkBatchId` reaches every report-mate's audit row. Undo goes through `undoReleasedRows` (`visits/[id]/actions.ts`) → `undo_visit_release` with `p_expected_released_at`; a combined report comes back only when EVERY member is in that map with the exact `released_at`, otherwise the RPC returns the batch ids in `skipped` with code `changed_since` (one code for every reason — item 2 is solved in TypeScript, not SQL).
- **0214 (#303)**: a release enqueues its patient notice in the same transaction (`notice_id`); an undo cancels this visit's pending/retry notices with nothing left released. `notifiedCount` = announced lines when the notice status is `"sent"`, else 0; `noticeRetrying` when the outbox is retrying.
- **The Queue's bulk Release spans visits.** `releaseTestsAction` (`queue/actions.ts:338`) groups survivors by visit and calls `releaseVisitSelection` per visit (4 at a time). **`undoReleaseBatchAction` today takes the FIRST row's `visit_id` and sends every id to that one visit** — a multi-visit batch would leave every other visit's lines released and name them "changed since". Item 1 must group the Undo by visit. This is the main design change in PR 1.
- **0211** locks claim/unclaim in id order; nothing here adds a locking function, so `src/lib/db/concurrency-proof-guard.test.ts` needs no new proof. (If a task ends up adding one, stop and ask — it needs a proof run at `--effort high`.)
- **Post-await state setters go back inside the transition** — `src/lib/react/transition-state.test.ts` scans every file; position is lexical, and hook methods count as setters only when listed in its `STATE_HOOK_METHODS`.
- **Fakes:** `src/lib/actions/visits/fake-release-db.ts` (release/undo RPC model, `from("test_requests" | "staff_profiles")`, `dbAudits`) and `src/lib/testing/fake-db.ts` (`FakeDb`: eq/is/in/not/gte/order/limit/range/maybeSingle, `metadata->>key`, instants compare equal across `Z`/`+00:00`; NOT insert/delete/or/neq/gt/lt).

## The PR split

| PR | Branch / worktree | Items | Migration | Size |
|---|---|---|---|---|
| **1 — Queue release Undo** | `feat/queue-release-undo` in `.worktrees/queue-release-undo` (this worktree, off origin/main 3456a346) | 1, 2, 3 | none | medium |
| **2 — Claim Undo + queue cleanups** | `feat/queue-claim-undo` — fresh worktree off origin/main **after PR 1 merges** | 4, 5, 10, 11 (query-surfaces text, panel clock, notice query string; grant deferred) | none | medium |
| **3 — Website Messages** | `feat/messages-kind-bulk` — fresh off origin/main after PR 2 merges | 6, 7, 8 | none | medium |
| **4 — Shared Undo-outcome hook** | `feat/bulk-undo-outcome-hook` — fresh off origin/main after PR 3 merges | 9 | none | medium-large |

**Why this order:** PR 4 rewrites every bar's outcome code, including the Queue bar's release Undo (PR 1) and the Messages bar's kind toggle (PR 3) — it must go last or it is rebuilt twice. PRs 2 and 3 touch disjoint files and could swap. **Never stack** a branch on an unmerged one (memory: the stacked-PR trap) — each PR starts from origin/main once its predecessor merged; this plan file reaches main with PR 1.

**Deferred (owner to decide later):** the `reclaim_panel_members` `service_role` EXECUTE revoke (needs a migration; nothing else in this batch needs one); bulk reply templates; inbox → Appointments "book the first one".

**Decisions to confirm at plan review (defaults chosen so work can start):**
1. **Item 2 wording** (default): `part of this report was released separately — undo it from the report page` (lowercase fragment, like `CHANGED_SINCE_REASON`, because it renders after "• *name*: ").
2. **Item 9, the provider-detail HMO bar** has no outcome panel or Undo today (the "three HMO bars" are AllUnbilled + AllAging in `hmo-claims-client.tsx`, sharing `useHistoricHmoOutcome`, plus `[providerId]/provider-detail-client.tsx` with none). Moving it onto the hook means it **gains** the same outcome + ↶ Undo AllUnbilled has. Planned that way (Task 4.6); say if it should stay as it is.
3. **Item 4 extension:** the bench page's own Claim button (it stays on the page) also gets the notice, by `router.replace` to the same `?claimed=&at=` URL — same mechanism as item 5. Planned (Task 2.3).
4. **Item 10's 0200 note:** 0200 is applied on prod and its header says a manual Restore "is not retried". Comments are never re-run, so the plan appends a dated follow-up paragraph to that header (no SQL change). Say if you would rather leave applied migration files untouched (the note then goes in `queue-restore-core.ts` only).
5. **Item 8 definition:** literally `resource_type = contact_message AND bulk_batch_size > 1` (so one-message bar actions and single-message Undo rows are excluded). The existing "Bulk actions" chip keeps its broader rule.

## Process rules (every PR)

- **Worktree:** `git worktree add -b <branch> .worktrees/<name> origin/main`, `git branch --unset-upstream`, `npm ci` (never symlink `node_modules`), copy `.env.local` from `.worktrees/queue-release-undo`.
- **Gates before every commit of code:** `npx vitest run <touched tests>`; before each PR: `npm run typecheck && npm run lint && npx vitest run` (whole suite; no GitHub test CI — run locally).
- **Guide:** content in the PR that changes a flow; bump version + date only at merge, after merging main, re-checking all four markers (toc tag `<p class="toc-tag">User guide · v2.NN</p>`, cover `<div><strong>Version</strong>2.NN · …`, footer `drmed.ph User Guide · v2.NN · …`, CLAUDE.md bullet line ~21). Main is v2.69 at plan time.
- **Browser runs** (`npm run check:bulk-select`, dev server `PORT=3007 npm run dev` from the worktree):
  1. Quiet machine: no vitest running, `uptime` load under ~14.
  2. Clear the local login limiter first, via node pg from the worktree (no psql):
     ```bash
     node -e 'const {Client}=require("pg");const c=new Client("postgresql://postgres:postgres@127.0.0.1:54322/postgres");c.connect().then(()=>c.query("delete from public.rate_limit_attempts where identifier like $1",["%::1%"])).then(r=>{console.log("cleared",r.rowCount);return c.end()})'
     ```
  3. Every Undo check uses `waitForUndoToFinish` (or `clickUndo`). Never `db reset` the shared local stack.
- **Commits** end with the attribution lines from the session; PR bodies end with the 🤖 line.

---

# PR 1 — Queue bulk Release Undo (items 1, 2, 3)

## File map (PR 1)

- Modify `src/lib/queue/bulk-queue.ts` — `BulkReleaseResult` gains `batchId?`, `notifiedCount`, `noticeRetrying?`.
- Modify `src/lib/visits/release-messages.ts` — move `ALREADY_NOTIFIED` + `NOTICE_RETRYING` here (shared by both bars); add `releaseUndoMessage`.
- Create `src/lib/visits/release-messages.test.ts` (or extend an existing one if present) — `releaseUndoMessage`.
- Modify `src/app/(staff)/staff/(dashboard)/queue/actions.ts` — `releaseTestsAction` mints one batch id, sums `notifiedCount`.
- Modify `src/app/(staff)/staff/(dashboard)/queue/release-actions.test.ts` — the "no Undo batch" test becomes the batch-id test + notifiedCount tests.
- Create `src/lib/actions/visits/release-undo-refusal.ts` — `RELEASED_SEPARATELY_REASON`, `idsWithMateReleasedOutsideBatch`.
- Modify `src/lib/actions/visits/fake-release-db.ts` — serve `from("result_test_requests")` from `links`.
- Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` — `undoReleaseBatchAction` groups by visit + uses the distinct reason.
- Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.undo-release-batch.test.ts` — report-mate test now expects the distinct reason; multi-visit tests.
- Create `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.release-undo-e2e.test.ts` — item 3.
- Modify `src/lib/visits/query-surfaces.test.ts` — classify `lib/actions/visits/release-undo-refusal.ts` (SURFACES `all`, LIFECYCLES `live`).
- Modify `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx` — release outcome carries ↶ Undo.
- Modify `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-release.test.tsx` — Undo tests.
- Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx` — import the two shared strings (no behaviour change).
- Modify `scripts/browser-check/bulk-select.ts` — `sectionQueueRelease` (V2 Email, V2b Physical, two visits each).
- Modify `docs/drmed-user-guide.html` — Lab queue "Several tests at once" (≈ line 849) and the Undo-release paragraph (≈ line 960).

### Task 1.1: Shared release strings + `releaseUndoMessage`

**Files:** Modify `src/lib/visits/release-messages.ts`; Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.tsx:40-43`; Test `src/lib/visits/release-messages.test.ts` (create if absent — `ls src/lib/visits/release-messages*` first).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ALREADY_NOTIFIED, NOTICE_RETRYING, releaseUndoMessage } from "./release-messages";

describe("releaseUndoMessage", () => {
  it("counts the tests put back and warns about a notice that went out", () => {
    expect(releaseUndoMessage({ restored: 3, notRestored: [], notified: true })).toBe(
      `Undone — 3 tests are back to Ready for release. ${ALREADY_NOTIFIED}`,
    );
  });
  it("one test, no notice", () => {
    expect(releaseUndoMessage({ restored: 1, notRestored: [], notified: false })).toBe(
      "Undone — 1 test is back to Ready for release.",
    );
  });
  it("names every test not undone, one per line", () => {
    expect(
      releaseUndoMessage({
        restored: 0,
        notRestored: [
          { label: "CBC — Santos, Maria", reason: "changed again since — refresh to see its status" },
          { label: "A test", reason: "part of this report was released separately — undo it from the report page" },
        ],
        notified: true,
      }),
    ).toBe(
      [
        "Nothing was undone.",
        "Not undone (2):",
        "• CBC — Santos, Maria: changed again since — refresh to see its status",
        "• A test: part of this report was released separately — undo it from the report page",
      ].join("\n"),
    );
  });
  it("keeps the shared wording the visit bar used", () => {
    expect(ALREADY_NOTIFIED).toBe("The patient was already notified that results are ready — tell them if needed.");
    expect(NOTICE_RETRYING).toBe(
      "The patient's \"result ready\" message has not gone out yet — it will retry automatically.",
    );
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`npx vitest run src/lib/visits/release-messages.test.ts`: exports missing).

- [ ] **Step 3: Implement** — append to `src/lib/visits/release-messages.ts`:

```ts
/** Release Undo does not un-notify: shown only when a notice actually went out (notifiedCount > 0). */
export const ALREADY_NOTIFIED =
  "The patient was already notified that results are ready — tell them if needed.";
/** The outbox could not finish the notice on the first try (0210): nothing has gone out yet. */
export const NOTICE_RETRYING =
  "The patient's \"result ready\" message has not gone out yet — it will retry automatically.";

/**
 * The Queue bar's message after a release Undo (undoReleaseBatchAction):
 * how many tests went back to Ready for release, the "already notified"
 * warning when the release's notice went out, and every test not undone by
 * name — the bar has cleared its selection, so this is the only record.
 */
export function releaseUndoMessage(r: {
  restored: number;
  notRestored: ReadonlyArray<{ label: string; reason: string }>;
  notified: boolean;
}): string {
  const head =
    r.restored === 0
      ? "Nothing was undone."
      : `Undone — ${r.restored} test${r.restored === 1 ? " is" : "s are"} back to Ready for release.${r.notified ? ` ${ALREADY_NOTIFIED}` : ""}`;
  if (r.notRestored.length === 0) return head;
  return [head, `Not undone (${r.notRestored.length}):`, ...r.notRestored.map((l) => `• ${l.label}: ${l.reason}`)].join("\n");
}
```

In `visits/[id]/bulk-action-bar.tsx` delete the two local `const NOTICE_RETRYING = …` / `const ALREADY_NOTIFIED = …` and import them: `import { ALREADY_NOTIFIED, NOTICE_RETRYING } from "@/lib/visits/release-messages";` (the visit bar keeps its own message text — no behaviour change in PR 1).

- [ ] **Step 4: Run** `npx vitest run src/lib/visits/release-messages.test.ts "src/app/(staff)/staff/(dashboard)/visits/[id]/bulk-action-bar.test.tsx"` — PASS.
- [ ] **Step 5: Commit** `feat(release): shared release notice strings + releaseUndoMessage`.

### Task 1.2: `releaseTestsAction` mints one batch id per call

**Files:** Modify `src/lib/queue/bulk-queue.ts:246-254`; Modify `src/app/(staff)/staff/(dashboard)/queue/actions.ts:338-438`; Test `src/app/(staff)/staff/(dashboard)/queue/release-actions.test.ts` (replace the test at line 326 "the queue sends only {source: queue} in p_audit (no Undo batch)…").

- [ ] **Step 1: Write the failing tests** (replace the line-326 test; keep the file's existing `setup`/`writes` helpers; add `const UUID_RE = /^[0-9a-f-]{36}$/;`):

```ts
it("one call mints ONE batch id: every visit's p_audit carries it, and it is returned", async () => {
  const fake = setup([
    { id: A, visitId: "v1" },
    { id: B, visitId: "v2" },
  ]);
  const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
  if (!res.ok) throw new Error(res.error);
  expect(res.batchId).toMatch(UUID_RE);
  const metas = writes(fake).map((w) => (w.args.p_audit as { metadata: Record<string, unknown> }).metadata);
  expect(metas).toHaveLength(2);
  expect(metas.every((m) => m.source === "queue" && m.bulk_batch_id === res.batchId)).toBe(true);
  // The database's own audit rows (0205) carry it on every released line, with the exact released_at.
  const released = fake.dbAudits.filter((a) => a.action === "test_request.released");
  expect(released.map((a) => a.metadata.bulk_batch_id)).toEqual([res.batchId, res.batchId]);
  expect(released.every((a) => a.metadata.released_at === FAKE_RELEASED_AT)).toBe(true);
});

it("a report-mate pulled in carries the batch id too", async () => {
  const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
  const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
  if (!res.ok) throw new Error(res.error);
  expect(res.alsoReleasedIds).toEqual([B]);
  const ids = fake.dbAudits.filter((a) => a.metadata.bulk_batch_id === res.batchId).map((a) => a.resource_id).sort();
  expect(ids).toEqual([A, B].sort());
});

it("returns no batch id when nothing was released", async () => {
  setup([{ id: A, status: "requested" }]);
  const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
  if (!res.ok) throw new Error(res.error);
  expect(res.changedIds).toEqual([]);
  expect(res.batchId).toBeUndefined();
  expect(res.notifiedCount).toBe(0);
});

it("notifiedCount counts only the visits whose notice was SENT", async () => {
  setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v1" }, { id: C, visitId: "v2" }]);
  // v1's bulk notice went out; v2's single notice was skipped (no contact).
  fx.notifyBulkResult = { status: "sent", channels: ["email"] };
  fx.notifyOneResult = { status: "skipped", channels: [], reason: "no contact details" };
  const res = await releaseTestsAction({ testRequestIds: [A, B, C], medium: "email" });
  if (!res.ok) throw new Error(res.error);
  expect(res.notifiedCount).toBe(2);
  expect(res.noticeRetrying).toBeUndefined();
});

it("noticeRetrying is set when any visit's notice is retrying, and never counted as notified", async () => {
  setup([{ id: A }]);
  fx.notifyOneResult = { status: "retrying", channels: [] };
  const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
  if (!res.ok) throw new Error(res.error);
  expect(res.notifiedCount).toBe(0);
  expect(res.noticeRetrying).toBe(true);
});
```

To make the last two runnable, change the two notify mocks at the top of the file to return a configurable outcome (add `notifyOneResult: undefined as unknown, notifyBulkResult: undefined as unknown` to `fx`, reset both to `undefined` in `beforeEach`):

```ts
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: unknown) => { fx.notifyOne.push(a); return fx.notifyOneResult; },
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => { fx.notifyBulk.push(a); return fx.notifyBulkResult; },
}));
```

Check the exact `ReleaseNoticeOutcome` shape in `src/lib/notifications/release-notice-outcome.ts` and use real field names in the two fixtures above.

- [ ] **Step 2: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/queue/release-actions.test.ts"` — the new tests FAIL (no `batchId`).

- [ ] **Step 3: Implement.** `src/lib/queue/bulk-queue.ts`:

```ts
export type BulkReleaseResult =
  | {
      ok: true;
      changedIds: string[];
      skipped: SkippedRow[];
      alsoReleasedIds: string[];
      warnings: string[];
      /** The 10-minute Undo handle (undoReleaseBatchAction) — present only when something was released. */
      batchId?: string;
      /** Released tests whose patient notice actually went out (status "sent"), summed over visits. */
      notifiedCount: number;
      /** true when any visit's notice is being retried by the outbox (0210) — nothing sent yet. */
      noticeRetrying?: true;
    }
  | { ok: false; error: string };
```

`queue/actions.ts` `releaseTestsAction` — before `mapWithConcurrency`:

```ts
  // Undo (PR C item 1): ONE server-minted batch id for the whole call, across
  // every visit — releaseVisitSelection hands it to release_visit_results,
  // whose audit rows (0205) stamp it, with the exact released_at, on EVERY
  // line it releases (report-mates included) and on the patient notice, so
  // undoReleaseBatchAction can read back exactly what this call released.
  // Returned only once something actually released (below).
  const batchId = crypto.randomUUID();
```

pass `bulkBatchId: batchId` to `releaseVisitSelection` (keep `auditMeta: { source: "queue" }`), and in the outcome loop:

```ts
  let notifiedCount = 0;
  let noticeRetrying = false;
  for (const out of outcomes) {
    changedIds.push(...out.changedIds);
    alsoReleasedIds.push(...out.alsoReleasedIds);
    for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
    for (const s of out.skipped) skipped.set(s.id, s.reason);
    // Same rule as the visit page (releaseSelectedAction): the REAL outcome.
    if (out.notice?.status === "sent") notifiedCount += out.announced.length;
    if (out.notice?.status === "retrying") noticeRetrying = true;
  }
```

and the return:

```ts
  const releasedAny = changedIds.length + alsoReleasedIds.length > 0;
  return {
    ok: true,
    changedIds,
    alsoReleasedIds,
    skipped: ids.filter((id) => skipped.has(id) && !changedSet.has(id)).map((id) => ({ id, reason: skipped.get(id)! })),
    warnings,
    notifiedCount,
    ...(releasedAny ? { batchId } : {}),
    ...(noticeRetrying ? { noticeRetrying: true as const } : {}),
  };
```

Update the header comment above `BulkReleaseSchema` ("This action owns the role gate, …") to add "and mints the call's Undo batch id".

- [ ] **Step 4: Run** the file — PASS; also `npx vitest run src/lib/queue` and `npm run typecheck` (other `BulkReleaseResult` consumers: `queue-bulk-bar.tsx`, `queue-bulk-release.test.tsx` mocks — add `notifiedCount: 0` to their mocked results if typecheck complains).
- [ ] **Step 5: Commit** `feat(queue): bulk Release mints one Undo batch id per call`.

### Task 1.3: Fake DB serves `result_test_requests`; the "released separately" helper (item 2)

**Files:** Modify `src/lib/actions/visits/fake-release-db.ts` (`execute`, header comment); Create `src/lib/actions/visits/release-undo-refusal.ts`; Create `src/lib/actions/visits/release-undo-refusal.test.ts`; Modify `src/lib/visits/query-surfaces.test.ts`.

- [ ] **Step 1: Write the failing test** `release-undo-refusal.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { makeFakeReleaseDb, FAKE_RELEASED_AT } from "./fake-release-db";
import { idsWithMateReleasedOutsideBatch, RELEASED_SEPARATELY_REASON } from "./release-undo-refusal";

const REL = { status: "released", releasedAt: FAKE_RELEASED_AT } as const;
const links = [
  { testRequestId: "a", resultId: "r1" },
  { testRequestId: "b", resultId: "r1" },
  { testRequestId: "c", resultId: "r2" },
  { testRequestId: "d", resultId: "r2" },
];

describe("idsWithMateReleasedOutsideBatch", () => {
  it("flags every refused batch id whose report has a live released member outside the batch", async () => {
    const fake = makeFakeReleaseDb({ rows: ["a", "b", "c", "d"].map((id) => ({ id, ...REL })), links });
    // Batch released a and c,d; b (a's mate) was released separately.
    const got = await idsWithMateReleasedOutsideBatch(fake.client, ["a", "c"], new Set(["a", "c", "d"]));
    expect([...got]).toEqual(["a"]);
  });
  it("a mate outside the batch that is no longer released (or deleted) does not count", async () => {
    const fake = makeFakeReleaseDb({
      rows: [{ id: "a", ...REL }, { id: "b", status: "ready_for_release" }],
      links: links.slice(0, 2),
    });
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["a"], new Set(["a"])))]).toEqual([]);
    const fake2 = makeFakeReleaseDb({ rows: [{ id: "a", ...REL }, { id: "b", ...REL, deleted: true }], links: links.slice(0, 2) });
    expect([...(await idsWithMateReleasedOutsideBatch(fake2.client, ["a"], new Set(["a"])))]).toEqual([]);
  });
  it("a plain line (no report) is never flagged; no ids means no read", async () => {
    const fake = makeFakeReleaseDb({ rows: [{ id: "x", ...REL }] });
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["x"], new Set(["x"])))]).toEqual([]);
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, [], new Set()))]).toEqual([]);
    // One membership read for ["x"] (no report -> stop), none for [].
    expect(fake.calls.map((c) => c.table)).toEqual(["result_test_requests"]);
  });
  it("never throws: a failed read flags nothing (the caller keeps the generic reason)", async () => {
    const fake = makeFakeReleaseDb({ rows: ["a", "b"].map((id) => ({ id, ...REL })), links: links.slice(0, 2) });
    fake.failNext("result_test_requests", "read");
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["a"], new Set(["a"])))]).toEqual([]);
  });
  it("the wording", () => {
    expect(RELEASED_SEPARATELY_REASON).toBe("part of this report was released separately — undo it from the report page");
  });
});
```

- [ ] **Step 2: Run** — FAIL (module missing; fake throws `unsupported table result_test_requests`).

- [ ] **Step 3a: Fake.** In `execute()` of `fake-release-db.ts`, before the `test_requests` branch:

```ts
    if (call.table === "result_test_requests") {
      hooks.beforeRead?.(call.table);
      const fail = take(call.table, ["read"]);
      if (fail) return { data: null, error: fail.error };
      const all = links.map((l) => ({ result_id: l.resultId, test_request_id: l.testRequestId }));
      return { data: all.filter((l) => call.filters.every((f) => matches(l, f))), error: null };
    }
```

and add to the header comment: `from("result_test_requests")` serves `links` as `{result_id, test_request_id}` rows (select only, same filters).

- [ ] **Step 3b: Helper** `src/lib/actions/visits/release-undo-refusal.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Why a 10-minute release Undo leaves a combined report alone when a member
 * of it was released by another call (PR C item 2). undo_visit_release only
 * says "changed_since" for every refused line; this names the common case
 * — the report was completed by a line released earlier, outside this batch
 * — so the operator knows to undo the whole report from its page instead of
 * retrying. Lowercase fragment: it renders after "• <test>: ".
 */
export const RELEASED_SEPARATELY_REASON =
  "part of this report was released separately — undo it from the report page";

/**
 * Of `refusedIds` (batch lines the Undo did not restore), the ones whose
 * combined report has a LIVE, RELEASED member this batch did not release
 * (`batchIds` = every line with a test_request.released row in the batch).
 * Wording only — the database already decided; so it never throws, and any
 * failed read flags nothing (the caller keeps CHANGED_SINCE_REASON).
 */
export async function idsWithMateReleasedOutsideBatch(
  supabase: SupabaseClient,
  refusedIds: readonly string[],
  batchIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const none = new Set<string>();
  if (refusedIds.length === 0) return none;
  try {
    const { data: own, error: ownErr } = await supabase
      .from("result_test_requests")
      .select("result_id, test_request_id")
      .in("test_request_id", [...refusedIds]);
    if (ownErr || !own || own.length === 0) return none;
    const reportOf = new Map(own.map((l) => [l.test_request_id as string, l.result_id as string]));
    const { data: members, error: memErr } = await supabase
      .from("result_test_requests")
      .select("result_id, test_request_id")
      .in("result_id", [...new Set(reportOf.values())]);
    if (memErr || !members) return none;
    const outside = members.filter((m) => !batchIds.has(m.test_request_id as string));
    if (outside.length === 0) return none;
    const { data: released, error: relErr } = await supabase
      .from("test_requests")
      .select("id")
      .in("id", outside.map((m) => m.test_request_id as string))
      .eq("status", "released")
      .is("deleted_at", null);
    if (relErr || !released) return none;
    const releasedSet = new Set(released.map((r) => r.id as string));
    const flagged = new Set(outside.filter((m) => releasedSet.has(m.test_request_id as string)).map((m) => m.result_id as string));
    return new Set(refusedIds.filter((id) => flagged.has(reportOf.get(id) ?? "")));
  } catch {
    return none;
  }
}
```

(Type the client the way sibling files do — `raced-release.ts` takes a `SupabaseClient`; match it. If the typed client rejects `result_test_requests` columns, use the generated `Database` types instead of the `as string` casts.)

- [ ] **Step 3c: Classify** in `src/lib/visits/query-surfaces.test.ts` — SURFACES, next to `lib/actions/visits/raced-release.ts`:

```ts
  "lib/actions/visits/release-undo-refusal.ts": {
    meaning: "all",
    why: "Words a refused release Undo: reads whether a combined report's OTHER members are released, by id. Reports are chemistry-only, but the read is by id and makes no lab-vs-bill claim — a doctor line can never be a report member, so filtering it would be dead weight.",
  },
```

LIFECYCLES (live section, next to the visit page's actions):

```ts
  "lib/actions/visits/release-undo-refusal.ts": {
    lifecycle: "live",
    why: "A deleted report-mate is not 'released separately' — only live released lines count, so the read filters deleted_at.",
  },
```

- [ ] **Step 4: Run** `npx vitest run src/lib/actions/visits/release-undo-refusal.test.ts src/lib/visits/query-surfaces.test.ts src/lib/actions/visits` — PASS.
- [ ] **Step 5: Commit** `feat(release): name a report-mate released outside the Undo batch`.

### Task 1.4: `undoReleaseBatchAction` — group by visit + distinct refusal (items 1, 2)

**Files:** Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:492-625`; Test `…/visits/[id]/actions.undo-release-batch.test.ts`.

- [ ] **Step 1: Write the failing tests.** In `actions.undo-release-batch.test.ts`:
  1. Change the test at line 151 ("a report-mate this batch did NOT release keeps the report released and is not named") to expect `res.notRestored` toEqual `[{ id: "a", reason: RELEASED_SEPARATELY_REASON }]` (import it from `@/lib/actions/visits/release-undo-refusal`); rename it "…is named with the released-separately reason, and the mate itself is not named".
  2. Keep line 138's test as is (a mate CHANGED since inside the batch keeps `CHANGED_SINCE_REASON` — b is in the batch, so no member is outside it).
  3. Add a `loadBatchAcross(visitOf: Record<string, string>, …)` variant of `loadBatch` that writes `metadata.visit_id` per id, and seed rows with `visitId` per id. New tests:

```ts
describe("undoReleaseBatchAction — a Queue batch across visits", () => {
  it("undoes every visit's lines, one undo_visit_release per visit, all under ONE new batch id", async () => {
    const fake = setup(
      [
        { id: "a", visitId: "v1", ...REL },
        { id: "x", visitId: "v1", ...REL },
        { id: "y", visitId: "v2", ...REL },
      ],
    );
    loadBatchAcross({ a: "v1", x: "v1", y: "v2" });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["a", "x", "y"], notRestored: [] });
    const calls = undoCalls(fake);
    expect(calls.map((c) => [c.args.p_visit_id, c.args.p_test_request_ids])).toEqual([
      ["v1", ["a", "x"]],
      ["v2", ["y"]],
    ]);
    const undoIds = calls.map((c) => (c.args.p_audit as { metadata: { bulk_batch_id: string } }).metadata.bulk_batch_id);
    expect(new Set(undoIds).size).toBe(1);
    // Every visit's release surfaces are refreshed.
    expect(fx.revalidate).toEqual(expect.arrayContaining([["/staff/visits/v1", undefined], ["/staff/visits/v2", undefined]]));
  });

  it("one visit's database refusal names that visit's lines; the other visit still comes back", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ a: "v1", y: "v2" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "This visit was deleted from the queue. Restore it before undoing a release." });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["y"]);
    expect(res.notRestored).toEqual([{ id: "a", reason: "This visit was deleted from the queue. Restore it before undoing a release." }]);
  });

  it("every visit refused: an error, not an empty success", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }]);
    loadBatchAcross({ a: "v1" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Nope." });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({ ok: false, error: "Nope." });
  });

  it("a batch row with no visit_id is named, not guessed onto another visit", async () => {
    setup([{ id: "a", visitId: "v1", ...REL }, { id: "b", visitId: "v1", ...REL }]);
    loadBatchAcross({ a: "v1", b: "" }); // "" = omit visit_id
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["a"]);
    expect(res.notRestored).toEqual([{ id: "b", reason: CHANGED_SINCE_REASON }]);
  });
});
```

(`failNextRpc` is one-shot and calls run in id-sorted visit order `v1` → `v2`; run visits **sequentially** in sorted order so this is deterministic — see Step 3. The visit page's `refuseIfVisitDeleted` read goes through `fx.db.from("visits")`, already stubbed live.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Replace the body of `undoReleaseBatchAction` after the `releasedRows.length === 0` check with:

```ts
  const notRestored: Array<{ id: string; reason: string }> = [];
  // Every id THIS batch released (its own test_request.released audit row is
  // in the batch), whatever changedSince says — only these are ever named,
  // never a report-mate released separately (Finding 4, P1).
  const batchReleasedIds = new Set<string>();
  // visit -> the batch's lines on it, and the exact released_at each line's
  // audit row recorded (the release identity undo_visit_release checks).
  // A Queue release spans visits (releaseTestsAction), the visit page's is one.
  const byVisit = new Map<string, { ids: string[]; expected: Map<string, string> }>();
  const seen = new Set<string>();
  for (const row of releasedRows) {
    const id = row.resource_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    batchReleasedIds.add(id);
    const vid = row.metadata?.visit_id;
    if (typeof vid !== "string" || vid === "") {
      // release_visit_results always stamps visit_id; never guess a visit.
      notRestored.push({ id, reason: CHANGED_SINCE_REASON });
      continue;
    }
    if (loaded.changedSince.has(id)) {
      notRestored.push({ id, reason: CHANGED_SINCE_REASON });
      continue;
    }
    const group = byVisit.get(vid) ?? { ids: [], expected: new Map<string, string>() };
    group.ids.push(id);
    const releasedAt = row.metadata?.released_at;
    // A row whose audit lacks released_at is sent but left out of the map, so
    // the database refuses it rather than restoring it on a guess.
    if (typeof releasedAt === "string") group.expected.set(id, releasedAt);
    byVisit.set(vid, group);
  }
  if (byVisit.size === 0) {
    return notRestored.length > 0 ? { ok: true, restoredIds: [], notRestored } : { ok: false, error: UNDO_EXPIRED };
  }

  const supabase = await createClient();
  // ONE new batch id for the whole Undo, every visit — so the Undo is itself
  // one traceable batch (audit "Whole batch"), as on every other bar.
  const undoBatchId = crypto.randomUUID();
  const restoredIds: string[] = [];
  const refusedByDb: string[] = [];
  let failedVisits = 0;
  let firstError: string | null = null;
  // Sequential, in visit-id order: deterministic, and a batch is at most a
  // few visits. 0198's locks make each visit's undo all-or-nothing per report.
  for (const visitId of [...byVisit.keys()].sort()) {
    const group = byVisit.get(visitId)!;
    const result = await undoReleasedRows(
      supabase,
      session,
      visitId,
      group.ids,
      "Undone within 10 minutes of release",
      { bulk: true, via: BULK_UNDO_VIA, undo_of_batch: parsed.data.batchId, bulk_batch_id: undoBatchId },
      group.expected,
    );
    // Every release surface (queue, dashboard, the visit) — as Unrelease does.
    revalidateReleaseSurfaces(visitId);
    if (!result.ok) {
      failedVisits += 1;
      firstError ??= result.error;
      for (const id of group.ids) notRestored.push({ id, reason: result.error });
      continue;
    }
    restoredIds.push(...result.undoneIds);
    for (const id of result.skippedIds) if (batchReleasedIds.has(id)) refusedByDb.push(id);
  }
  // Every visit's call failed: an error, exactly as the one-visit Undo
  // returned (the bar keeps ↶ Undo for a retry).
  if (failedVisits === byVisit.size && firstError !== null) {
    return { ok: false, error: firstError };
  }

  // Item 2: a report the database refused because one of its members was
  // released by ANOTHER call says so, instead of the generic "changed since".
  const separately = await idsWithMateReleasedOutsideBatch(supabase, refusedByDb, batchReleasedIds);
  const restoredSet = new Set(restoredIds);
  for (const id of refusedByDb) {
    if (restoredSet.has(id) || notRestored.some((n) => n.id === id)) continue;
    notRestored.push({ id, reason: separately.has(id) ? RELEASED_SEPARATELY_REASON : CHANGED_SINCE_REASON });
  }
  return { ok: true, restoredIds, notRestored: notRestored.filter((n) => !restoredSet.has(n.id)) };
```

Notes for the implementer:
- `restoredIds` order: the existing tests expect id order within a visit (`undo_visit_release` returns `undone` sorted by id) — keep visit order then RPC order, and fix expectations only where a test explicitly covered one visit (none should change).
- The "every visit refused → error" rule: `{ ok:false, error }` whenever every visit's call failed — exactly what the one-visit Undo returned before (it returned the error even when some lines had been refused as changed since).
- Update the big comment block above the function: say it groups by visit (Queue release), one undo batch id, and that refused report lines name `RELEASED_SEPARATELY_REASON` when a member was released outside the batch. Import `idsWithMateReleasedOutsideBatch, RELEASED_SEPARATELY_REASON` from `@/lib/actions/visits/release-undo-refusal`.
- The test file's `setup()` serves `fx.db.from(table)` via the fake — `result_test_requests` now works through Task 1.3.

- [ ] **Step 4: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/visits/[id]"` — PASS (all existing tests unchanged except the renamed one).
- [ ] **Step 5: Commit** `feat(release): batch Undo groups by visit; names a report released separately`.

### Task 1.5: End-to-end behavioural test of the release Undo (item 3)

**Files:** Create `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.release-undo-e2e.test.ts`.

The existing undo test mocks `loadOwnBatchRows`. This one does not: it releases through the real `releaseTestsAction` (Queue) and `releaseSelectedAction` (visit page), mirrors the database's audit rows (`fake.dbAudits`) into a `FakeDb` `audit_log`, and lets the real `loadOwnBatchRows` (admin client → `FakeDb`) decide window / actor / already-undone / changed-since.

- [ ] **Step 1: Write the test.**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End to end, nothing between the two actions mocked except auth, the
// clock and the patient notice: release (queue or visit page) -> the
// database's own audit rows (0205, modelled by fake-release-db) -> the REAL
// loadOwnBatchRows over those rows -> undoReleaseBatchAction -> undo_visit_release.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  user: "u1" as string,
  role: "medtech" as string,
  release: null as unknown,
  auditDb: null as unknown,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: fx.user, role: fx.role, actual_role: fx.role, view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: fx.user, role: "admin" }) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/consent/gate", () => ({ isConsentGateRequired: async () => false, getConsentCurrentByPatient: async () => new Map() }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => ({ status: "sent", channels: ["email"] }) }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => ({ status: "sent", channels: ["email"] }) }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
// Staff client = the release model (+ live visits); admin client = audit_log only.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fx.release }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (fx.auditDb as FakeDb).client() }));

import { FakeDb } from "@/lib/testing/fake-db";
import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";
import { RELEASED_SEPARATELY_REASON } from "@/lib/actions/visits/release-undo-refusal";
import { CHANGED_SINCE_REASON, UNDO_ALREADY, UNDO_EXPIRED } from "@/lib/ui/bulk-undo";

const { undoReleaseBatchAction, releaseSelectedAction } = await import("./actions");
const { releaseTestsAction } = await import("../../queue/actions");

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, X, Y] = [u(1), u(2), u(3), u(4), u(5)];
const T0 = Date.parse("2026-10-01T02:00:00.000Z");
let mirrored = 0;
let fake: ReturnType<typeof makeFakeReleaseDb>;

function world(rows: FakeTestRow[], links: FakeLink[] = []) {
  fake = makeFakeReleaseDb({ rows, links, actorRole: () => fx.role });
  const inner = fake.client as { from: (t: string) => Record<string, unknown>; rpc: unknown };
  fx.release = {
    rpc: inner.rpc,
    from(table: string) {
      if (table === "visits") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: { deleted_at: null }, error: null });
        return q;
      }
      return inner.from(table);
    },
  };
  fx.auditDb = new FakeDb();
  mirrored = 0;
}
/** Copy the database's new audit rows into audit_log, stamped "now" (the faked clock). */
function mirror() {
  const fresh = fake.dbAudits.slice(mirrored);
  mirrored = fake.dbAudits.length;
  (fx.auditDb as FakeDb).seed(
    "audit_log",
    fresh.map((a, i) => ({ id: `al-${mirrored}-${i}`, ...a, created_at: new Date(Date.now()).toISOString() })),
  );
}
const status = (id: string) => fake.rows.find((r) => r.id === id)!.status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fx.user = "u1";
  fx.role = "medtech";
});
afterEach(() => vi.useRealTimers());

describe("release -> Undo, end to end", () => {
  it("Queue: report-mates in the batch come back together, across two visits", async () => {
    world(
      [
        { id: A, visitId: "v1" }, { id: B, visitId: "v1" }, // report r1
        { id: X, visitId: "v2" },
      ],
      [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }],
    );
    const rel = await releaseTestsAction({ testRequestIds: [A, X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    expect(rel.alsoReleasedIds).toEqual([B]);
    mirror();
    vi.setSystemTime(T0 + 5 * 60_000);
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    expect(res).toEqual({ ok: true, restoredIds: [A, B, X], notRestored: [] });
    expect([A, B, X].map(status)).toEqual(["ready_for_release", "ready_for_release", "ready_for_release"]);
  });

  it("a mate released OUTSIDE the batch refuses the whole report with the released-separately reason", async () => {
    world(
      [{ id: A }, { id: B, status: "released", releasedAt: "2026-10-01T01:00:00.000001+00:00" }, { id: X }],
      [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }],
    );
    const rel = await releaseSelectedAction("v1", [A, X], "email");
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    expect(res).toEqual({ ok: true, restoredIds: [X], notRestored: [{ id: A, reason: RELEASED_SEPARATELY_REASON }] });
    expect([status(A), status(B)]).toEqual(["released", "released"]);
  });

  it("a mate changed since INSIDE the batch keeps the generic reason", async () => {
    world([{ id: A }, { id: B }], [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }]);
    const rel = await releaseSelectedAction("v1", [A, B], "email");
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    // Someone else touched B after the batch (any newer audit row outside it).
    vi.setSystemTime(T0 + 60_000);
    (fx.auditDb as FakeDb).seed("audit_log", [{
      id: "foreign", actor_id: "u2", actor_type: "staff", action: "result.amended", resource_type: "test_request",
      resource_id: B, metadata: {}, created_at: new Date(Date.now()).toISOString(),
    }]);
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual([]);
    expect(res.notRestored.map((n) => [n.id, n.reason]).sort()).toEqual([[A, CHANGED_SINCE_REASON], [B, CHANGED_SINCE_REASON]].sort());
  });

  it("expired after 10 minutes", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "physical" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    vi.setSystemTime(T0 + 10 * 60_000 + 1);
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(status(X)).toBe("released");
  });

  it("another actor cannot undo it (reads as expired — the batch is never disclosed)", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    fx.user = "u2";
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(status(X)).toBe("released");
  });

  it("already undone: the second Undo refuses and writes nothing", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    expect((await undoReleaseBatchAction({ batchId: rel.batchId })).ok).toBe(true);
    mirror();
    const calls = fake.rpcCalls.length;
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_ALREADY });
    expect(fake.rpcCalls.length).toBe(calls);
  });
});
```

Adjust while making it pass (do NOT weaken it): the queue action reads `test_requests` with `visits!inner(...)` embeds that `fake-release-db` already projects; the role must be one `LAB_CAPABLE_ROLES` and `evaluateRelease` accept (medtech + chemistry section in the fake's defaults); if `FakeDb` cannot express one of `loadOwnBatchRows`' reads, extend `FakeDb` minimally and say so in the commit.

- [ ] **Step 2: Run it.** Expect every test to PASS once Tasks 1.2–1.4 are in; if one fails, the failure is a real gap — fix the code, not the test.
- [ ] **Step 3: Mutation check** (memory: vacuous-assertions trap). Temporarily (a) drop `bulkBatchId: batchId` in `releaseTestsAction`, (b) make `idsWithMateReleasedOutsideBatch` return an empty set, (c) remove the per-visit grouping (send all ids to the first visit). Each must turn at least one test red. Revert all three; note the results in the commit body.
- [ ] **Step 4: Commit** `test(release): end-to-end release -> Undo through the real batch loader`.

### Task 1.6: Queue bar — ↶ Undo on the release outcome

**Files:** Modify `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx` (types at 53-68, `runUndo` 177-223, `release()` 282-308); Test `…/queue/queue-bulk-release.test.tsx`.

- [ ] **Step 1: Write the failing tests** (append to `queue-bulk-release.test.tsx`; mock `../visits/[id]/actions` now also exports `undoReleaseBatchAction: vi.fn()`; import it):

```ts
const OK = { ok: true as const, changedIds: ["t1"], alsoReleasedIds: [], skipped: [], warnings: [], notifiedCount: 0 };

it("offers ↶ Undo after a release that carries a batch id", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1" });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("CBC"));
  await user.click(screen.getByRole("button", { name: /^Release 1/ }));
  expect(await screen.findByRole("button", { name: "↶ Undo" })).toBeTruthy();
});

it("no batch id, no Undo", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("CBC"));
  await user.click(screen.getByRole("button", { name: /^Release 1/ }));
  await screen.findByText(/Released 1/);
  expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
});

it("says the patient was notified only when a notice went out, and again after Undo", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", notifiedCount: 1 });
  vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: true, restoredIds: ["t1"], notRestored: [] });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("CBC"));
  await user.click(screen.getByRole("button", { name: /^Release 1/ }));
  expect(await screen.findByText(/already notified/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "↶ Undo" }));
  expect(vi.mocked(undoReleaseBatchAction)).toHaveBeenCalledWith({ batchId: "b-1" });
  expect(await screen.findByText(/Undone — 1 test is back to Ready for release\. The patient was already notified/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  expect(router.refresh).toHaveBeenCalled();
});

it("a physical release never claims a notice, before or after Undo", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", notifiedCount: 0 });
  vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: true, restoredIds: ["t1"], notRestored: [] });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("CBC"));
  await user.click(screen.getByRole("button", { name: /^Release 1/ }));
  await screen.findByRole("button", { name: "↶ Undo" });
  expect(screen.queryByText(/already notified/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "↶ Undo" }));
  await screen.findByText(/back to Ready for release/);
  expect(screen.queryByText(/already notified/)).toBeNull();
});

it("names a panel member not undone by its card, with the released-separately reason", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, changedIds: ["c1", "c2"], batchId: "b-1" });
  vi.mocked(undoReleaseBatchAction).mockResolvedValue({
    ok: true,
    restoredIds: [],
    notRestored: [{ id: "c1", reason: "part of this report was released separately — undo it from the report page" }],
  });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("Chemistry"));
  await user.click(screen.getByRole("button", { name: /^Release 2/ }));
  await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
  expect(await screen.findByText(/• Chemistry \(2 tests\) — Reyes, Ana: part of this report was released separately/)).toBeTruthy();
});

it("says the notice is retrying, and keeps Undo after a retryable Undo failure", async () => {
  vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", noticeRetrying: true });
  vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: false, error: "Couldn't confirm what was undone — check the visit page." });
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("CBC"));
  await user.click(screen.getByRole("button", { name: /^Release 1/ }));
  expect(await screen.findByText(/will retry automatically/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "↶ Undo" }));
  expect(await screen.findByText(/Couldn't confirm what was undone/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
});
```

(Check `bulkQueueMessage`'s exact "Released 1 …" text and the release button label in the bar before relying on the regexes; the remaining existing tests in the file must also get `notifiedCount: 0` in their mocked results.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** in `queue-bulk-bar.tsx`:
  - Import `undoReleaseBatchAction` alongside `deleteSampleVisitsFromQueueAction` from `../visits/[id]/actions`; import `NOTICE_RETRYING, ALREADY_NOTIFIED, releaseUndoMessage` from `@/lib/visits/release-messages`.
  - `OutcomeUndo` gains a discriminant:

```ts
interface OutcomeUndo {
  /** "queue": Claim / Unclaim / Delete (undoBulkQueueAction). "release": undoReleaseBatchAction. */
  kind: "queue" | "release";
  batchId: string;
  doneAt: number;
  /** Selection key (queue) or TEST id (release, panel members included) -> the row's label. */
  labelOf: Record<string, string>;
  /** release only: the patient's notice went out (notifiedCount > 0) — the Undo message repeats the warning. */
  notified?: boolean;
}
```

  - In `done()` set `kind: "queue"` on the undo it builds.
  - `release()` success branch:

```ts
      const msg = bulkReleaseMessage(ids.length, result, labelsByTestId(rowsByKey));
      const lines = [msg, ...result.warnings];
      // Undo does not un-notify: say so only when a notice actually went out.
      const notified = result.notifiedCount > 0;
      if (notified) lines.push(ALREADY_NOTIFIED);
      if (result.noticeRetrying) lines.push(NOTICE_RETRYING);
      const labels = labelsByTestId(rowsByKey);
      const undo: OutcomeUndo | null =
        result.batchId && result.changedIds.length + result.alsoReleasedIds.length > 0
          ? {
              kind: "release",
              batchId: result.batchId,
              doneAt: Date.now(),
              labelOf: Object.fromEntries(ids.map((id) => [id, labels[id]?.label ?? "A test"])),
              notified,
            }
          : null;
      start(() => {
        setOutcome({ message: lines.join("\n"), edits: selectionEdits, undo });
        clearKeys(keys);
        closePanel();
      });
      router.refresh();
```

  - `runUndo(u)` dispatches: `const r = u.kind === "release" ? await undoReleaseBatchAction({ batchId: u.batchId }) : await undoBulkQueueAction({ batchId: u.batchId });` — the failure branch is shared; the success branch for `"release"` builds

```ts
        const message = releaseUndoMessage({
          restored: r.restoredIds.length,
          notRestored: r.notRestored.map((n) => ({ label: u.labelOf[n.id] ?? "A test", reason: n.reason })),
          notified: u.notified === true,
        });
```

  and the `"queue"` branch keeps today's `restoredTestCount` code. TypeScript: `r` is `BulkUndoResult | QueueUndoResult` — narrow with `u.kind` first (two awaits in two branches is clearer than one union). Both success branches end with `startUndo(() => setOutcome({...}))` then `router.refresh()`. Two notRestored ids for one panel card render twice with the same label — acceptable and honest (two tests); do not collapse.
  - Delete the comment "Release keeps #261's outcome text; it carries no Undo here …"; update the bar's header comment to list Release among the actions with Undo.

- [ ] **Step 4: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/queue" src/lib/react/transition-state.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(queue): 10-minute Undo for the bulk Release`.

### Task 1.7: Browser checks V2 / V2b, guide, gates, PR

**Files:** Modify `scripts/browser-check/bulk-select.ts` (new `sectionQueueRelease`, called from `main` after `sectionVisitRelease`); Modify `scripts/seed/bulk-select-fixtures.sql` only if a second paid visit with BSQ tests is missing (read it first — visits 9101–9107 exist); Modify `docs/drmed-user-guide.html`.

- [ ] **Step 1: Browser check.** Model it on `sectionVisitRelease` (lines 1464-1555): for `[["V2 Queue Release (Email) across two visits -> Undo", "email", true], ["V2b Queue Release (Physical) across two visits -> Undo, no notified claim", "physical", false]]`:
  1. SQL: set `BSQ-CBC` on visit 9101 and one BSQ test on a second PAID fixture visit (pick from the fixtures file) to `ready_for_release`; record `clock_timestamp()`.
  2. Open `/staff/queue` on the Pending-release tab (find the tab link/param in `queue/page.tsx`), tick both rows, pick the medium in the bar's `select[aria-label="Release medium"]`, click `Release 2`.
  3. Wait for `OUTCOME`; read `result.notified` rows for both visits since the click (same `noticeSent` logic as V1); `expectNotified = notified && noticeSent`.
  4. Assert both lines `released`; `latestBatchId(c, "test_request.released")` is one id covering both visits (`select count(distinct metadata->>'visit_id') from audit_log where metadata->>'bulk_batch_id' = $1` = 2).
  5. Click `↶ Undo`, `waitForUndoToFinish(page)`; assert both lines `ready_for_release`, outcome includes `back to Ready for release`, `includes("already notified") === expectNotified` before and after; `undoRowCount(c, batchId) === 2`.
  Use the medtech page (`med`) if the queue's Pending-release tab is lab-only; the role must be able to release.
- [ ] **Step 2: Guide** (content only, no version bump):
  - ≈ line 849 "Several tests at once" note: add one sentence — `Release` now offers `↶ Undo` on the outcome panel for 10 minutes (same rules as the visit page's Release selected: only your own release, a chemistry report comes back whole, the patient is not un-notified — the panel says so when a message went out).
  - ≈ line 960–961 Undo paragraph: one sentence — a 10-minute Undo leaves a chemistry report released when part of it was released separately, and says so ("part of this report was released separately — undo it from the report page").
- [ ] **Step 3: Gates.** `npm run typecheck && npm run lint && npx vitest run` (whole suite, log to a file in the scratchpad; report only failures).
- [ ] **Step 4: Browser run** (quiet machine, limiter cleared, dev server :3007): `npm run check:bulk-select` — every check passes, including V1/V1b/V2/V2b. Capture the log to a file; report the pass count.
- [ ] **Step 5: Whole-branch review** (Sonnet, general-purpose + the code-reviewer template; `superpowers:code-reviewer` does not exist in superpowers 6.x): diff vs `origin/main`, against this plan's PR 1 section. Fix confirmed findings, re-run gates.
- [ ] **Step 6: PR.** `git fetch && git merge origin/main` (resolve, re-run gates), push `-u origin feat/queue-release-undo`, `gh pr create` (no migration; body: items 1–3, decisions, test evidence, browser pass count). **Stop for the owner's merge OK.** At merge: merge main again, bump the guide version (four markers), merge, confirm the Vercel prod deploy.

---

# PR 2 — Claim Undo on the single-test and report-page Claim + queue cleanups (items 4, 5, 10, 11)

Worktree: `git worktree add -b feat/queue-claim-undo .worktrees/queue-claim-undo origin/main` after PR 1 merges. Re-read every file below before editing — PR 1 changed `queue/actions.ts` and `queue-bulk-bar.tsx`.

## File map (PR 2)

- Modify `src/app/(staff)/staff/(dashboard)/queue/actions.ts` — `claimTestAction` mints a batch id, stamps `started_at`, predicates `assigned_to is null`.
- Modify `src/lib/queue/claim-undo-link.ts` (+ test) — `claimBenchHref`, `claimUndoOpen`.
- Move `queue/consolidated/[visitId]/[groupId]/claim-undo-notice.tsx` (+ test) → `queue/claim-undo-notice.tsx` (shared by both pages); it drops its query string when the window closes (item 11).
- Modify `src/app/(staff)/staff/(dashboard)/queue/claim-button.tsx` — single claim navigates/replaces with `claimBenchHref`.
- Modify `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx` — reads `claimed`/`at`, renders the notice.
- Modify `queue/consolidated/[visitId]/[groupId]/actions.ts`, `consolidated-form.tsx`, `page.tsx` — `claimConsolidated` mints a batch id; the form replaces the URL with `claimReportHref`.
- Modify `src/components/staff/row-selection/bulk-outcome.tsx` (+ create `bulk-outcome.test.tsx`) — the clock ticks only while an Undo is open.
- Modify `src/lib/actions/visits/queue-restore-core.ts` (+ test) — writes in `withLifecycleRetry`.
- Modify `supabase/migrations/0200_panel_undo_all_or_nothing.sql` — header follow-up note (comment only; decision 4).
- Modify `src/lib/visits/query-surfaces.test.ts` — `why` text for panel-writes.ts / queue/actions.ts.
- Modify `scripts/browser-check/bulk-select.ts` — QC1–QC4; `docs/drmed-user-guide.html` — Lab queue + report page Claim.

### Task 2.1: `claimTestAction` returns an Undo batch id (item 4, server)

**Files:** Modify `queue/actions.ts:56-138`; Test: create `queue/actions.claim-single-undo.test.ts` (behavioural, `FakeDb` from `src/lib/testing/fake-db.ts`, same mock block as `actions.undo-behaviour.test.ts` — copy its header).

- [ ] **Step 1: Failing tests:**
  1. A claim returns `{ ok: true, batchId }` (uuid); the write's patch carries a `started_at` equal to the audit row's `metadata.started_at`; the audit row has `resource_id = id`, `metadata.bulk_batch_id = batchId`, `bulk_batch_size: 1`, `visit_id`, and NO `panel_key`.
  2. The write predicates `status = requested`, `assigned_to is null`, `deleted_at is null` (seed a `requested` row with `assigned_to = OTHER` → refused "This test was already claimed or its status changed.", nothing written).
  3. **Round trip:** after the claim, seed the audit row into `audit_log` (the `audit` mock pushes into `db.tables.audit_log` — follow how `actions.undo-behaviour.test.ts` wires it) and call `undoBulkQueueAction({ batchId })` → `{ ok: true, restoredIds: [id], restoredTestCount: 1, notRestored: [] }`; the row is `requested`, unassigned, `started_at` null.
  4. A lost-race retry (first write returns `40P01` via `db.hooks.beforeWrite`) re-sends the SAME `started_at` (hoisted — the closure is re-evaluated on retry).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**

```ts
export type ClaimResult = { ok: true; batchId?: string } | { ok: false; error: string };
```

In `claimTestAction`, before the write:

```ts
  // Undo (PR C item 4): a one-test "bulk" batch, minted here (never from
  // input), so the bench page can offer the bar's 10-minute ↶ Undo for this
  // claim (undoBulkQueueAction). started_at is hoisted: withLifecycleRetry
  // re-runs the closure, and the Undo predicates on the exact value written.
  const batchId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
```

write `.update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })`, add `.is("assigned_to", null)` after `.eq("status", "requested")` (the state the operator saw, as `claimTestsCore` predicates), and audit metadata `{ visit_id: data.visit_id, started_at: startedAt, bulk_batch_id: batchId, bulk_batch_size: 1 }`. Return `{ ok: true, batchId }`. Check `src/lib/patients/write-guards.test.ts:113-134` still passes (EXEMPT keyed `queue/actions.ts:claimTestAction`) and `queue_claim_remarks` (0160) is unaffected (it reads claimed rows by `resource_id`).
- [ ] **Step 4: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/queue" src/lib/patients/write-guards.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(queue): single-test Claim records an Undo batch`.

### Task 2.2: Link helpers + the shared notice (items 4, 5, 11 — notice query string)

**Files:** Modify `src/lib/queue/claim-undo-link.ts` + `claim-undo-link.test.ts`; `git mv` the notice and its test to `src/app/(staff)/staff/(dashboard)/queue/claim-undo-notice.tsx` / `.test.tsx` (update the import in the consolidated `page.tsx`; the action import becomes `./actions`).

- [ ] **Step 1: Failing tests** — `claim-undo-link.test.ts`:

```ts
describe("claimBenchHref", () => {
  it("adds the batch and the claim time", () => {
    expect(claimBenchHref("t1", BATCH, NOW)).toBe(`/staff/queue/t1?claimed=${BATCH}&at=${NOW}`);
  });
  it("is the bare bench URL with no batch", () => {
    expect(claimBenchHref("t1", undefined, NOW)).toBe("/staff/queue/t1");
  });
});
describe("claimUndoOpen", () => {
  it("is open until exactly ten minutes, closed one millisecond later", () => {
    expect(claimUndoOpen(NOW - 10 * 60_000, NOW)).toBe(true);
    expect(claimUndoOpen(NOW - 10 * 60_000 - 1, NOW)).toBe(false);
  });
});
```

`claim-undo-notice.test.tsx` — replace "offers no Undo once the 10-minute window has closed" with:

```ts
it("a notice whose window has already closed removes ?claimed=&at= at once, keeping other params", async () => {
  searchParams = new URLSearchParams("edit=1&claimed=x&at=1");
  render(<ClaimUndoNotice batchId={BATCH} doneAt={Date.now() - 11 * MIN} reportName="Chemistry" />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1?edit=1", { scroll: false }));
});
it("drops the query string when the window closes while the notice is open", async () => {
  vi.useFakeTimers();
  render(<ClaimUndoNotice batchId={BATCH} doneAt={Date.now()} reportName="Chemistry" />);
  expect(router.replace).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10 * MIN + 1);
  expect(router.replace).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1", { scroll: false });
  vi.useRealTimers();
});
```

(mock `useSearchParams: () => searchParams` in the test's `next/navigation` mock; default `new URLSearchParams()`; update the "Dismiss replaces the URL…" expectation to the same `(path, { scroll: false })` form.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `claim-undo-link.ts`:

```ts
import { UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";

/** The bench page URL for a single test, carrying its Undo batch when it has one. */
export function claimBenchHref(testRequestId: string, batchId: string | undefined, nowMs: number): string {
  const base = `/staff/queue/${testRequestId}`;
  return batchId ? `${base}?claimed=${encodeURIComponent(batchId)}&at=${nowMs}` : base;
}

/** Whether a claim done at `doneAt` is still inside the 10-minute Undo window (the server re-proves it). */
export function claimUndoOpen(doneAt: number, nowMs: number): boolean {
  return nowMs - doneAt <= UNDO_WINDOW_MS;
}
```

`claim-undo-notice.tsx` — add, with `useSearchParams`:

```ts
  const searchParams = useSearchParams();
  // Item 11: once the window has closed the notice has nothing to offer, so
  // drop ?claimed=&at= (other params kept) — otherwise Back re-shows a stale
  // "You claimed …" long after. Runs at mount for an already-closed window.
  useEffect(() => {
    const strip = () => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("claimed");
      next.delete("at");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    };
    const left = doneAt + UNDO_WINDOW_MS - Date.now();
    if (left <= 0) {
      strip();
      return;
    }
    const t = setTimeout(strip, left + 1);
    return () => clearTimeout(t);
  }, [doneAt, pathname, router, searchParams]);
```

and use the same strip for Dismiss (extract `stripParams()` above the effect; the effect and `onDismiss` call it). The page-side guard in Task 2.4 also skips rendering an expired notice, so the replace normally runs only for a notice that expired while open.
- [ ] **Step 4: Run** the two test files + `npx vitest run src/lib/react/transition-state.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(queue): shared claim Undo notice; drops its query string when the window closes`.

### Task 2.3: Claim button → bench page carries the batch (item 4, client)

**Files:** Modify `queue/claim-button.tsx`; Test: create `queue/claim-button.test.tsx` (jsdom; mock `./actions`, `./panel-actions`, `next/navigation`).

- [ ] **Step 1: Failing tests:** (a) single + `navigateOnClaim`: `claimTestAction` → `{ ok: true, batchId: "b" }` ⇒ `router.push("/staff/queue/t1?claimed=b&at=<n>")` (match `/^\/staff\/queue\/t1\?claimed=b&at=\d+$/`); (b) single, no `navigateOnClaim` (the bench page's own button) ⇒ `router.replace(<same shape>, { scroll: false })` and `router.refresh` not needed (replace re-renders); (c) `{ ok: true }` with no batch ⇒ push to the bare URL / no replace; (d) error ⇒ alert, no navigation; (e) the panel path is unchanged (`claimReportHref`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — single branch: `const r = await claimTestAction(testRequestId!); if (r.ok) batchId = r.batchId; result = r;` then

```ts
      const href = panel ? claimReportHref(panel, batchId, Date.now()) : claimBenchHref(testRequestId!, batchId, Date.now());
      if (navigateOnClaim) router.push(href);
      // The bench page's own Claim stays on the page: show its Undo notice there too.
      else if (batchId) router.replace(href, { scroll: false });
```

(Both inside the transition after the await — navigation is not a state setter, but if lint/transition tests object, wrap in `start(() => …)`.) Update the comment "Only a panel claim carries an Undo batch" → both do.
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(queue): single Claim carries its Undo to the bench page`.

### Task 2.4: Bench page renders the notice

**Files:** Modify `queue/[id]/page.tsx` (Props 154-159, read at 455, render before `</ReleaseOutcomeProvider>` ≈ 771-777); also the consolidated `page.tsx` gets the same expiry guard.

- [ ] **Step 1:** `searchParams: Promise<{ undo?: string; claimed?: string | string[]; at?: string | string[] }>`; at line 455:

```ts
  const sp = (await searchParams) ?? {};
  const openUndo = sp.undo === "1";
  // ?claimed=<batch>&at=<ms> — set by the single-test Claim (PR C item 4).
  // eslint-disable-next-line react-hooks/purity -- per-request snapshot, passed down as a number prop
  const nowMs = Date.now();
  const { batchId: claimedParam, doneAt: claimedAt } = parseClaimUndoParams(sp, nowMs);
  const showClaimUndo = claimedParam !== null && claimUndoOpen(claimedAt, nowMs);
```

render `{showClaimUndo ? <ClaimUndoNotice batchId={claimedParam!} doneAt={claimedAt} reportName={svc.name} /> : null}` after the `Open visit →` link inside the provider (check the variable that holds the service name at that point). Apply `claimUndoOpen` on the consolidated page too (line ~670).
- [ ] **Step 2:** `npm run typecheck`; `npx vitest run src/lib/visits/query-surfaces.test.ts` (page reads unchanged). **Commit** `feat(queue): bench page shows the claim Undo notice`.

### Task 2.5: Report page's own Claim gets Undo (item 5)

**Files:** Modify `queue/consolidated/[visitId]/[groupId]/actions.ts:17-34`, `consolidated-form.tsx:53-67`; Test: extend the consolidated actions test if present (`ls` the folder), else create `actions.claim-undo.test.ts` (FakeDb + the `claim_panel_members` rpc stub pattern from `src/lib/actions/queue/panel-writes*.test.ts`).

- [ ] **Step 1: Failing tests:** `claimConsolidated({ visitId, groupId, testRequestIds })` returns `{ ok: true, batchId }`; the audit rows are per member with `bulk_batch_id`, `panel_key = panelRowKey(visitId, groupId)`, `started_at`, `bulk_batch_size: 1` (i.e. `claimPanelMembers` got a `PanelBatchAudit`); missing/invalid `visitId`/`groupId` ⇒ the existing parse-error path. Round trip: `undoBulkQueueAction({ batchId })` (panel branch → `unclaimPanelMembers`) restores the panel — reuse the rpc fakes from `panel-actions.test.ts`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**

```ts
const ClaimSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
  testRequestIds: z.array(z.string().uuid()).min(1),
});
type ClaimOutcome = { ok: true; batchId?: string } | { ok: false; error: string };

export async function claimConsolidated(input: unknown): Promise<ClaimOutcome> {
  try {
    const { visitId, groupId, testRequestIds } = ClaimSchema.parse(input);
    const session = await requireActiveStaff();
    const supabase = await createClient();
    // Undo (PR C item 5): a one-panel batch minted here, never from input —
    // the same shape claimPanelAction writes, so undoBulkQueueAction's panel
    // branch puts the whole panel back (unclaim_panel_members, all or nothing).
    const batchId = crypto.randomUUID();
    const result = await claimPanelMembers(session, supabase, testRequestIds, undefined, {
      batchId,
      batchSize: 1,
      panelKey: panelRowKey(visitId, groupId),
      visitId,
    });
    if (!result.ok) return result;
    revalidatePath("/staff/queue");
    return { ok: true, batchId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

(Check `claimPanelMembers`' exact parameter order in `src/lib/actions/queue/panel-writes.ts:45` — `claimPanelAction` passes `auditExtra` then `batch`; pass the same `auditExtra` it does, `{ visit_id, report_group_id }`, for parity.) Form:

```ts
    startTransition(async () => {
      const res = await claimConsolidated({
        visitId: props.visit.id,
        groupId: props.group.id,
        testRequestIds: props.testRequestIds,
      });
      if (!res.ok) {
        startTransition(() => {
          setError(res.error);
        });
        return;
      }
      // The page re-renders with its ↶ Undo notice (same URL handshake as the queue row's Claim).
      router.replace(claimReportHref({ visitId: props.visit.id, groupId: props.group.id }, res.batchId, Date.now()), { scroll: false });
    });
```

(check the prop names the form really has; keep `router.refresh()` only if `replace` to the same path does not re-render the server component — test in the browser check.)
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(queue): report page Claim offers Undo`.

### Task 2.6: `BulkOutcomePanel` ticks only while an Undo is open (item 11)

**Files:** Modify `src/components/staff/row-selection/bulk-outcome.tsx:15-19,54`; Create `src/components/staff/row-selection/bulk-outcome.test.tsx` (jsdom, stub `ResizeObserver`).

- [ ] **Step 1: Failing tests** (spy `vi.spyOn(globalThis, "setInterval")` with fake timers):
  1. No `undo` prop ⇒ no interval is ever set.
  2. An open Undo ⇒ one interval; after `doneAt + windowMs` passes (advance timers) the ↶ Undo button is gone **without waiting for the next 15 s tick** (advance exactly `windowMs - elapsed + 1` ms) and the interval is cleared (`clearInterval` called).
  3. An Undo whose window already closed at mount ⇒ no interval, no button.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**

```ts
const subscribeNever = () => () => {};

// Ticks every 15 s while an Undo is open and once more exactly when it closes
// (so the button goes on time), then stops — a panel with no Undo, or whose
// window has passed, keeps no timer (item 11).
function subscribeUntil(closesAt: number) {
  return (onTick: () => void) => {
    if (Date.now() >= closesAt) return () => {};
    const i = setInterval(onTick, 15_000);
    const t = setTimeout(() => {
      clearInterval(i);
      onTick();
    }, closesAt - Date.now() + 1);
    return () => {
      clearInterval(i);
      clearTimeout(t);
    };
  };
}
```

in the component: `const closesAt = undo ? undo.doneAt + undo.windowMs : null;` `const subscribe = useMemo(() => (closesAt === null ? subscribeNever : subscribeUntil(closesAt)), [closesAt]);` `const now = useSyncExternalStore(subscribe, clientNow, () => undo?.doneAt ?? 0);`. `clientNow` keeps whole seconds; the close tick at `closesAt + 1` reads a second ≥ `closesAt` only if rounding allows — make the `open` test `now - undo.doneAt < undo.windowMs` robust by using an un-rounded snapshot ONLY for the final tick (simplest: `const clientNow = () => Date.now() >= closesAtRef ? Date.now() : Math.floor(...)`) — or round UP: `Math.ceil(Date.now() / 1000) * 1000`. Pick one, keep `getSnapshot` stable between ticks, and let test 2 decide. Update the comment block above.
- [ ] **Step 4: Run** the new test + every bar test (`npx vitest run "src/app/(staff)/staff/(dashboard)" src/components/staff`) — PASS.
- [ ] **Step 5: Commit** `fix(bulk-bar): outcome clock ticks only while an Undo is open`.

### Task 2.7: Manual Restore retries a lost lock race once (item 10)

**Files:** Modify `src/lib/actions/visits/queue-restore-core.ts:90-139`; Test `src/lib/actions/visits/queue-restore-core.test.ts`; Modify `supabase/migrations/0200_panel_undo_all_or_nothing.sql` header (comment only).

- [ ] **Step 1: Failing tests** (follow the file's existing fake): the manual path's UPDATE fails once with `{ code: "40P01" }` then succeeds ⇒ `{ ok: true, restoredIds }`, exactly two UPDATE calls, one audit row per line (not two); a second `40P01` ⇒ the translated error, nothing audited; the expected-`deleted_at` (Undo) path retries per group the same way; a non-retryable error (`XX000`) is NOT retried.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — wrap each `admin.from("test_requests").update(...)…select("id")` in `withLifecycleRetry(() => …)` (import from `@/lib/patients/lifecycle-retry`). Comment: "PR B's proof (S7) showed a manual Restore racing a panel Undo-restore on one visit can lose a deadlock (40P01): 0183's waived-visit guard takes the visit after the line, the reverse of restore_panel_members. The loser is rolled back whole, so one retry in a fresh transaction can never double-restore." Append to the 0200 header, inside the comment block, after the S7 paragraph:

```sql
-- Follow-up (2026-10-0X, PR "queue-claim-undo"): the manual queue Restore
-- (restoreTestRequestsForVisit) now retries once too, via withLifecycleRetry —
-- a manual Restore that loses this cycle re-runs instead of showing 40P01.
-- Comment only; nothing in this migration changed.
```

(Use the real date. Skip this file edit if the owner chose "leave applied migrations untouched" at plan review; put the note in the TS comment only.)
- [ ] **Step 4: Run** `npx vitest run src/lib/actions/visits src/lib/db` — PASS (the concurrency-proof guard strips comments, so the header edit is inert). **Step 5: Commit** `fix(queue): manual Restore retries a lost lock race once`.

### Task 2.8: query-surfaces `why` text (item 11)

**Files:** Modify `src/lib/visits/query-surfaces.test.ts` (SURFACES ≈ 183-198, LIFECYCLES ≈ 513-536).

- [ ] **Step 1:** Read `src/lib/actions/queue/panel-writes.ts` and `queue/actions.ts` as they are now. Rewrite the four `why` strings so they describe every read: panel-writes.ts — claims a panel, AND `reclaimPanelMembers` / `restorePanelMembers` (0200 — Undo of a bulk Unclaim / Delete; restore reads DELETED members on the admin client by the batch's own ids + exact `deleted_at`); queue/actions.ts — claim (single, with its Undo batch), unclaim, reassign, release, and `undoBulkQueueAction`'s reclaim / restore branches now going through those RPC helpers. Keep each classification (`structural`/`live`, `lab`/`live`) unless a read genuinely changed meaning — then stop and ask.
- [ ] **Step 2:** `npx vitest run src/lib/visits/query-surfaces.test.ts` — PASS. **Commit** `docs(tests): query-surfaces reasons mention reclaim/restore`.

### Task 2.9: Browser checks, guide, gates, PR

- [ ] **Browser** — new `sectionClaimUndo` in `bulk-select.ts`:
  - **QC1** queue single Claim → lands on `/staff/queue/<id>?claimed=…`, notice "You claimed …", ↶ Undo → row `requested`, unassigned, `started_at` null; an audit row with `undo_of_batch`.
  - **QC2** bench page's own Claim (open an unclaimed test's bench page, click Claim) → notice → Undo → requested.
  - **QC3** report page Claim (`/staff/queue/consolidated/<visit>/<group>` of the panel fixture, visit 9107) → notice → Undo → every member requested, one `test_request.unclaimed` per member with `undo_of_batch`.
  - **QC4** open `/staff/queue/<id>?claimed=<uuid>&at=<now − 11 min>` → no notice and, after load, the URL has no `claimed`/`at`.
  Every Undo check uses `clickUndo`/`waitForUndoToFinish`.
- [ ] **Guide** — Lab queue (≈ 849 note / Claim description) and the report page "Buttons" (≈ 878): Claim on a test or a report now shows "You claimed …" with `↶ Undo` for 10 minutes.
- [ ] **Gates, whole-branch review, merge main, push, PR, stop for merge OK** — as Task 1.7 Steps 3–6.

---

# PR 3 — Website Messages: stale-click guard, corporate-lead bulk toggle, audit preset (items 6, 7, 8)

Worktree `feat/messages-kind-bulk` off origin/main after PR 2 merges.

## File map (PR 3)

- Modify `src/app/(staff)/staff/(dashboard)/messages/actions.ts` — `updateMessageStatusAction(id, status, from)`; `updateMessageKindManyAction`; `undoMessageKindManyAction`.
- Create `src/app/(staff)/staff/(dashboard)/messages/actions.single-status.test.ts`; extend `actions.bulk.test.ts` (kind describe blocks) — `FakeDb`.
- Modify `messages/[id]/message-actions.tsx`; create `messages/[id]/message-actions.click.test.tsx` (jsdom).
- Create `src/lib/contact-messages/bulk-kind.ts` + `bulk-kind.test.ts`.
- Modify `messages/messages-bulk-bar.tsx` (+ test), `messages/page.tsx` (rows carry `kind`).
- Modify `src/lib/audit/bulk-filter.ts` (+ test), `src/app/(staff)/staff/(dashboard)/audit/page.tsx`.
- Modify `scripts/browser-check/bulk-select.ts` (M9, M10, M11, A3); `docs/drmed-user-guide.html` (§3.11 messages ≈ 779; audit log ≈ 1089).

### Task 3.1: Single status button predicates on what the page showed (item 6)

- [ ] **Step 1: Failing tests** (`actions.single-status.test.ts`, FakeDb header copied from `actions.bulk.test.ts`):
  1. `updateMessageStatusAction(id, "closed", "new")` on a `new` row → ok; the UPDATE's filters include `["eq", ["status", "new"]]`; audit `{ from: "new", to: "closed" }`.
  2. The row is `booked` (someone booked it after the page loaded) → `{ ok: false, error: MESSAGE_STALE_SINGLE }`, NO update call, no audit.
  3. A race between read and write (`db.hooks.beforeWrite` flips status to `booked`) → the write matches nothing → `MESSAGE_STALE_SINGLE`, no audit.
  4. A transition the matrix forbids (`from: "closed"`, `to: "replied"`) → `notAllowedReason("closed","replied")` capitalised, no read of the row needed beyond auth.
  5. A missing row → "That message could not be found."
  6. A malformed `from` → the zod error path.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** In `src/lib/contact-messages/bulk-status.ts` add
  `export const MESSAGE_STALE_SINGLE = "This message changed since you opened it — refresh to see its current status.";`
  In `actions.ts`: `StatusSchema` gains `from: z.enum(CONTACT_MESSAGE_STATUSES)`; signature `updateMessageStatusAction(id: string, status: StaffStatusTarget, from: ContactMessageStatus)`; after parse:

```ts
  if (!canTransition(parsed.data.from, parsed.data.status)) {
    const why = notAllowedReason(parsed.data.from, parsed.data.status);
    return { ok: false, error: why.charAt(0).toUpperCase() + why.slice(1) + "." };
  }
```

  existing read unchanged; `if (existing.status !== parsed.data.from) return { ok: false, error: MESSAGE_STALE_SINGLE };`; write adds `.eq("status", parsed.data.from)`; `if (!data) return { ok: false, error: MESSAGE_STALE_SINGLE };`. Update the bulk action's doc comment ("the single action above reads then writes by id alone") — it no longer does.
- [ ] **Step 4: Client** — `message-actions.tsx` `fireStatus`: `await updateMessageStatusAction(messageId, target, status)`; on error `alert(result.error)` then `router.refresh()` (so the page shows the status that won). jsdom test (`message-actions.click.test.tsx`): clicking "Mark closed" on a `new` message calls the action with `(id, "closed", "new")`; an error alerts it and refreshes.
- [ ] **Step 5: Run — PASS; Commit** `fix(messages): single status change refuses a stale click`.

### Task 3.2: Pure kind helpers

**Files:** Create `src/lib/contact-messages/bulk-kind.ts` + test.

- [ ] **Step 1: Failing tests** for: `MESSAGE_KIND_BUTTONS` (two buttons: `{ to: "corporate", label: "Mark corporate lead", verb: "Marked", tail: "as corporate leads" }`, `{ to: "general", label: "Not a corporate lead", verb: "Marked", tail: "as not corporate leads" }` — check `formatBulkOutcome` output reads "Marked 3 messages as corporate leads." and fix the tails if not); `bulkKindPlan(selected: {key, kind}[])` → `{ corporate: [general keys], general: [corporate keys] }`; `planKindUndo(rows)` keeps only `contact_message.kind_changed` rows with string `from`/`to` in `CONTACT_MESSAGE_KINDS`, `from !== to`, a non-empty string `updated_at`, first row per id; `bucketKindUndo(entries)` groups by `(current, restoreTo, stamp)`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement:**

```ts
// Website Messages bulk "corporate lead" toggle (PR C item 7) — the pure half.
import { CONTACT_MESSAGE_KINDS, isContactMessageKind, type ContactMessageKind } from "./labels";
import type { AuditRowForUndo } from "@/lib/ui/bulk-undo";

export const MESSAGE_KIND_BUTTONS: ReadonlyArray<{
  to: ContactMessageKind; label: string; verb: string; tail: string;
}> = [
  { to: "corporate", label: "Mark corporate lead", verb: "Marked", tail: "as corporate leads" },
  { to: "general", label: "Not a corporate lead", verb: "Marked", tail: "as not corporate leads" },
];

export function bulkKindPlan(selected: ReadonlyArray<{ key: string; kind: string }>): Record<ContactMessageKind, string[]> {
  const plan: Record<ContactMessageKind, string[]> = { general: [], corporate: [] };
  for (const s of selected) {
    if (s.kind === "general") plan.corporate.push(s.key);
    else if (s.kind === "corporate") plan.general.push(s.key);
  }
  return plan;
}

export interface KindUndoEntry {
  id: string;
  /** The kind the bulk call set (the Undo write's predicate). */
  current: ContactMessageKind;
  /** The kind it had before. */
  restoreTo: ContactMessageKind;
  /** The updated_at the bulk write produced (touch_updated_at) — any later change of the row moves it. */
  stamp: string;
}

export function planKindUndo(rows: readonly AuditRowForUndo[]): KindUndoEntry[] {
  const out: KindUndoEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.resource_id;
    if (!id || seen.has(id) || row.action !== "contact_message.kind_changed") continue;
    const m = row.metadata ?? {};
    const from = m.from, to = m.to, stamp = m.updated_at;
    if (typeof from !== "string" || !isContactMessageKind(from)) continue;
    if (typeof to !== "string" || !isContactMessageKind(to) || to === from) continue;
    if (typeof stamp !== "string" || stamp === "") continue;
    seen.add(id);
    out.push({ id, current: to, restoreTo: from, stamp });
  }
  return out;
}

export function bucketKindUndo(entries: readonly KindUndoEntry[]): Array<Omit<KindUndoEntry, "id"> & { ids: string[] }> {
  const byKey = new Map<string, Omit<KindUndoEntry, "id"> & { ids: string[] }>();
  for (const e of entries) {
    const key = JSON.stringify([e.current, e.restoreTo, e.stamp]);
    const { id, ...rest } = e;
    const b = byKey.get(key) ?? { ...rest, ids: [] };
    b.ids.push(id);
    byKey.set(key, b);
  }
  return [...byKey.values()];
}
```

(`CONTACT_MESSAGE_KINDS` import only if a test needs it.)
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(messages): pure helpers for the bulk corporate-lead toggle`.

### Task 3.3: `updateMessageKindManyAction` + `undoMessageKindManyAction` (item 7, server)

- [ ] **Step 1: Failing tests** (new `describe` blocks in `actions.bulk.test.ts`, same FakeDb setup; the FakeDb update returns the patched row — seed `updated_at` and make a `beforeWrite` hook stamp `updated_at = WRITE_AT` on matched rows to model `touch_updated_at`):
  - forward: role gate (medtech refused before any read); input caps (`MAX_BULK_ROWS`); each entry carries the kind the operator SAW; a row whose kind changed since is skipped `MESSAGE_CHANGED_REASON`, a missing one `MESSAGE_GONE_REASON`; the write is `update({ kind: to }).in(ids).eq("kind", from)` per `from`; each changed row gets one `contact_message.kind_changed` audit row `{ from, to, updated_at: <returned>, bulk_batch_id, bulk_batch_size }`; `handled_by`/`handled_at` untouched; `batchId` only when something changed.
  - Undo: same actor, 10 min, once (via `loadOwnBatchRows` over seeded audit rows, like the status Undo tests); restores `kind` with predicates `kind = current` AND `updated_at = stamp`; a message whose status or notes changed since (newer audit row → `changedSince`, or `updated_at` moved) is not restored, named `CHANGED_SINCE_REASON`; Undo audit `{ from: current, to: restoreTo, via: BULK_UNDO_VIA, undo_of_batch, bulk_batch_id: <new>, bulk_batch_size }`; a status batch id passed to the kind Undo restores nothing (`planKindUndo` ignores status rows → `UNDO_EXPIRED`).
- [ ] **Step 2: Run — FAIL. Step 3: Implement** in `messages/actions.ts`, modelled line for line on `updateMessageStatusManyAction` / `undoMessageStatusManyAction` (lines 145-365):

```ts
const BulkKindSchema = z.object({
  entries: z.array(z.object({ id: z.string().uuid(), from: z.enum(CONTACT_MESSAGE_KINDS) })).min(1).max(MAX_BULK_ROWS),
  to: z.enum(CONTACT_MESSAGE_KINDS),
});

/**
 * The inbox bar's "Mark corporate lead" / "Not a corporate lead" (PR C item 7):
 * same batch + 10-minute Undo shape as the status bar. Each entry carries the
 * kind the operator SAW; one guarded UPDATE per `from`, so a message re-typed
 * since is skipped and named. Only `kind` changes — the status handler
 * (handled_by/at) is about status, so it is left alone. The audit row keeps
 * the updated_at the write produced (touch_updated_at): the Undo predicates on
 * it, so ANY later change of the message (status, notes, a reply) blocks it.
 */
export async function updateMessageKindManyAction(input: unknown): Promise<BulkMessageResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = BulkKindSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const { to } = parsed.data;
  const fromOf = new Map<string, ContactMessageKind>();
  for (const e of parsed.data.entries) if (!fromOf.has(e.id)) fromOf.set(e.id, e.from);
  const ids = [...fromOf.keys()];
  const skipped: Array<{ id: string; reason: string }> = [];
  const candidates = ids.filter((id) => {
    if (fromOf.get(id) !== to) return true;
    skipped.push({ id, reason: `already ${to === "corporate" ? "a corporate lead" : "not a corporate lead"}` });
    return false;
  });
  const supabase = await createClient();
  const current = new Map<string, string>();
  if (candidates.length > 0) {
    const { data, error } = await supabase.from("contact_messages").select("id, kind").in("id", candidates);
    if (error) return { ok: false, error: translatePgError(error) };
    for (const r of data ?? []) current.set(r.id, r.kind);
  }
  const byFrom = new Map<ContactMessageKind, string[]>();
  for (const id of candidates) {
    const kind = current.get(id);
    if (kind === undefined) skipped.push({ id, reason: MESSAGE_GONE_REASON });
    else if (kind !== fromOf.get(id)) skipped.push({ id, reason: MESSAGE_CHANGED_REASON });
    else byFrom.set(fromOf.get(id)!, [...(byFrom.get(fromOf.get(id)!) ?? []), id]);
  }
  const batchId = crypto.randomUUID();
  const changed: Array<{ id: string; from: ContactMessageKind; updated_at: string }> = [];
  const erroredIds = new Set<string>();
  let firstError: { code?: string; message: string } | null = null;
  for (const [from, groupIds] of byFrom) {
    const { data, error } = await supabase
      .from("contact_messages")
      .update({ kind: to })
      .in("id", groupIds)
      .eq("kind", from)
      .select("id, updated_at");
    if (error) {
      console.error("bulk message kind write failed", { ids: groupIds, error });
      firstError ??= error;
      for (const id of groupIds) erroredIds.add(id);
      continue;
    }
    for (const r of data ?? []) changed.push({ id: r.id, from, updated_at: r.updated_at });
  }
  const changedSet = new Set(changed.map((c) => c.id));
  for (const groupIds of byFrom.values()) {
    for (const id of groupIds) {
      if (!changedSet.has(id)) skipped.push({ id, reason: erroredIds.has(id) ? MESSAGE_WRITE_FAILED_REASON : MESSAGE_CHANGED_REASON });
    }
  }
  if (changed.length > 0) {
    const { ip, ua } = await ipAndAgent();
    await Promise.all(changed.map((row) => audit({
      actor_id: session.user_id, actor_type: "staff", action: "contact_message.kind_changed",
      resource_type: "contact_message", resource_id: row.id,
      metadata: { from: row.from, to, updated_at: row.updated_at, bulk_batch_id: batchId, bulk_batch_size: ids.length },
      ip_address: ip, user_agent: ua,
    })));
    revalidatePath("/staff/messages");
    for (const row of changed) revalidatePath(`/staff/messages/${row.id}`);
  }
  if (firstError && changed.length === 0) return { ok: false, error: translatePgError(firstError) };
  const reasonOf = new Map(skipped.map((s) => [s.id, s.reason]));
  return {
    ok: true,
    changedIds: ids.filter((id) => changedSet.has(id)),
    skipped: ids.filter((id) => reasonOf.has(id)).map((id) => ({ id, reason: reasonOf.get(id)! })),
    ...(changed.length > 0 ? { batchId } : {}),
  };
}
```

`undoMessageKindManyAction(input)` — copy `undoMessageStatusManyAction`, swap `planMessageUndo`/`bucketMessageUndo` for `planKindUndo`/`bucketKindUndo`, the write to `.update({ kind: bucket.restoreTo }).in("id", bucket.ids).eq("kind", bucket.current).eq("updated_at", bucket.stamp).select("id")`, and the audit action/metadata to `contact_message.kind_changed` `{ from: current, to: restoreTo, via, undo_of_batch, bulk_batch_id: undoBatchId, bulk_batch_size }`. No `/staff` layout revalidation (the sidebar badge counts status, not kind). The `"already …"` skip wording is a new reason — add it as an exported constant in `bulk-kind.ts` if a test pins it.
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(messages): bulk corporate-lead toggle with 10-minute Undo (server)`.

### Task 3.4: Bar + page (item 7, client)

- [ ] **Step 1: Failing jsdom tests** in `messages-bulk-bar.test.tsx` (ROWS gain `kind`; m1 general, m2 corporate): the bar shows `Mark corporate lead (1)` and `Not a corporate lead (1)` for a mixed selection; clicking sends `{ entries: [{ id, from: <kind seen> }], to }`; outcome names skipped rows; ↶ Undo calls `undoMessageKindManyAction` (NOT the status Undo) and names what did not come back; a status action's Undo still calls `undoMessageStatusManyAction`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement:** `MessageRowInfo` gains `kind: ContactMessageKind`; `page.tsx` passes `kind: isContactMessageKind(r.kind) ? r.kind : "general"`; `OutcomeUndo` gains `action: "status" | "kind"`; `runUndo` picks the action by it; a second `MESSAGE_KIND_BUTTONS.map(...)` renders after the status buttons (variant `outline`), using `bulkKindPlan(selected)`; `run()` is generalised or a sibling `runKind()` added (keep the post-await `start(() => …)` re-wrap). Row selection `kinds` stay `[status]` (a kind change must not prune a selection; the snapshot `labelOf` already covers rows dropping out of `?kind=corporate`).
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(messages): corporate-lead toggle on the inbox bar`.

### Task 3.5: Audit-log preset "Website Messages bulk changes" (item 8)

- [ ] **Step 1: Failing tests** in `src/lib/audit/bulk-filter.test.ts`:

```ts
it("the Website Messages preset: contact_message rows of a bulk batch of 2+", () => {
  expect(AUDIT_BULK_PRESETS).toEqual([
    {
      key: "messages-bulk",
      label: "Website Messages bulk changes",
      hint: "Status or corporate-lead changes made to two or more messages at once, and their Undo",
      resourceType: "contact_message",
    },
  ]);
  expect(parseBulkPreset("messages-bulk")?.resourceType).toBe("contact_message");
  expect(parseBulkPreset("nope")).toBeNull();
  expect(parseBulkPreset(undefined)).toBeNull();
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** in `bulk-filter.ts`:

```ts
/** One-click audit views of one resource's bulk changes: resource_type + bulk_batch_size > 1. */
export const AUDIT_BULK_PRESETS = [
  {
    key: "messages-bulk",
    label: "Website Messages bulk changes",
    hint: "Status or corporate-lead changes made to two or more messages at once, and their Undo",
    resourceType: "contact_message",
  },
] as const;
export type AuditBulkPreset = (typeof AUDIT_BULK_PRESETS)[number];

export function parseBulkPreset(v: string | undefined): AuditBulkPreset | null {
  return AUDIT_BULK_PRESETS.find((p) => p.key === v) ?? null;
}
```

`audit/page.tsx`: `const preset = parseBulkPreset(params.preset);` after the `batchId` filter: `if (preset) query = query.eq("resource_type", preset.resourceType).gt("metadata->bulk_batch_size", 1);` (verify the supabase-js `.gt` on a `->` JSON path generates `metadata->bulk_batch_size=gt.1`, the same operator `BULK_AUDIT_OR` uses; the generated types may need a cast — follow how the page types the `.or()` string). Add a chip per preset right after "Bulk actions" in the Quick filters nav (same classes, `aria-current` when active, `href` toggles `preset` and clears `page`); add `preset` to `baseParams`, the `hasAnyFilter` list, the `Clear` link and the form's hidden inputs (mirror `bulk`).
- [ ] **Step 4: Run** `npx vitest run src/lib/audit` + typecheck — PASS. **Step 5: Commit** `feat(audit): Website Messages bulk changes preset`.

### Task 3.6: Browser checks, guide, gates, PR

- [ ] **Browser** (in `sectionMessages`): **M9** open BSQ Sender One's detail page, SQL-flip it to `booked`, click `Mark closed` → the alert/notice says it changed since, the row is still `booked`, no new `status_changed` audit row (handle the `alert` dialog with `page.once("dialog", d => d.accept())` — read the dialog message for the assertion). **M10** select One (general) + Two (corporate) → `Mark corporate lead (1)` → One `corporate`, one `kind_changed` row with the batch → ↶ Undo → One `general`, an Undo row with `undo_of_batch`. **M11** `Not a corporate lead` on Two with `?kind=corporate` in the URL → Two drops off the list, the outcome still names it; Undo restores `corporate`. **A3** audit page → chip "Website Messages bulk changes" → the pagination total equals `select count(*) from audit_log where resource_type='contact_message' and (metadata->>'bulk_batch_size')::int > 1`. Reset the touched fixture rows at the end (the reseed runs first next time anyway).
- [ ] **Guide** — §3.11 Website Messages "Several messages at once" (≈ 779): the corporate-lead buttons + Undo; the detail page refuses a stale status click ("changed since you opened it — refresh"). Audit Log row (≈ 1089): the new chip.
- [ ] **Gates, whole-branch review, merge main, push, PR, stop for merge OK** — as Task 1.7.

---

# PR 4 — Shared Undo-outcome hook (item 9)

Worktree `feat/bulk-undo-outcome-hook` off origin/main after PR 3 merges. **No behaviour change**: every existing bar test stays green, unmodified except where a test imports a moved constant. The one deliberate addition is decision 2 (provider-detail bar gains the outcome + Undo).

## File map (PR 4)

- Create `src/components/staff/row-selection/use-undo-outcome.ts` + `use-undo-outcome.test.tsx` (jsdom).
- Modify `src/lib/react/transition-state.test.ts` — `STATE_HOOK_METHODS.useUndoOutcome = ["show", "dismiss"]`.
- Modify the bars: `appointments/appointments-bulk-bar.tsx`, `queue/queue-bulk-bar.tsx`, `messages/messages-bulk-bar.tsx`, `visits/[id]/bulk-action-bar.tsx`, `admin/accounting/hmo-claims/hmo-claims-client.tsx` (`useHistoricHmoOutcome`), `admin/accounting/hmo-claims/[providerId]/provider-detail-client.tsx`.
- Modify `scripts/browser-check/bulk-select.ts` — H5 (provider-detail outcome + Undo); `docs/drmed-user-guide.html` ≈ 456 (HMO Claims: the provider page too).

### Task 4.1: The hook

- [ ] **Step 1: Failing tests** (`use-undo-outcome.test.tsx`, render a tiny harness component that uses the hook and renders `BulkOutcomePanel` from `undoProp`):
  1. `show(message, undo)` renders the message and ↶ Undo; `dismiss()` clears it.
  2. With `selectionEdits` given, a changed value drops the outcome on the next render; without it the outcome survives.
  3. Undo success: calls `undo(u)` once (a second click while pending does not call again), sets `describeUndo(result, u)`, hides Undo, and calls `router.refresh()` unless `refreshAfterUndo: false`.
  4. Undo failure: `UNDO_EXPIRED` / `UNDO_ALREADY` drop the button; any other error keeps it with the same `doneAt`; `onError: "prepend"` shows `${error}\n\n${previous}`, `"replace"` shows the error alone.
- [ ] **Step 2: Run — FAIL. Step 3: Implement:**

```ts
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OutcomeUndo as PanelUndo } from "./bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";

/** What every bar keeps about an Undo it offers: the server batch and when the action finished. */
export interface UndoHandle {
  batchId: string;
  doneAt: number;
}

export interface UndoOutcomeState<U extends UndoHandle> {
  message: string;
  /** selectionEdits when shown (row-selection bars); null for bars without one. */
  edits: number | null;
  undo: U | null;
}

type UndoCallResult<S> = ({ ok: true } & S) | { ok: false; error: string };

/**
 * The outcome / ↶ Undo / selectionEdits state machine every bulk bar shared
 * by copy (Appointments, Queue, Messages, the visit page's Tests bar, the HMO
 * claims bars). The bar still runs its forward action and builds its own
 * messages; this owns the outcome, the render-time drop rule, and the Undo
 * transition (post-await updates re-wrapped — transition-state.test.ts).
 * `show` / `dismiss` are setters: call them inside the bar's transition after
 * an await (STATE_HOOK_METHODS lists them).
 */
export function useUndoOutcome<U extends UndoHandle, S>(opts: {
  selectionEdits?: number;
  undo: (u: U) => Promise<UndoCallResult<S>>;
  describeUndo: (result: { ok: true } & S, u: U) => string;
  onError?: "prepend" | "replace";
  refreshAfterUndo?: boolean;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<UndoOutcomeState<U> | null>(null);
  const [undoing, startUndo] = useTransition();
  const edits = opts.selectionEdits ?? null;
  // A new deliberate selection edit drops the outcome (render-time, as before).
  if (outcome !== null && edits !== null && outcome.edits !== edits) setOutcome(null);

  function show(message: string, undo: U | null = null) {
    setOutcome({ message, edits, undo });
  }
  function dismiss() {
    setOutcome(null);
  }

  function runUndo(u: U) {
    if (undoing) return;
    const previous = outcome?.message ?? "";
    startUndo(async () => {
      const r = await opts.undo(u);
      if (!r.ok) {
        // Keep the snapshot for a retry inside the window — unless the server
        // says the window/batch itself is gone.
        const gone = r.error === UNDO_EXPIRED || r.error === UNDO_ALREADY;
        startUndo(() => {
          setOutcome({
            message: opts.onError === "replace" ? r.error : `${r.error}\n\n${previous}`,
            edits,
            undo: gone ? null : u,
          });
        });
        return;
      }
      const message = opts.describeUndo(r, u);
      startUndo(() => {
        setOutcome({ message, edits, undo: null });
      });
      if (opts.refreshAfterUndo !== false) router.refresh();
    });
  }

  function undoProp(undo: U | null): PanelUndo | null {
    return undo ? { doneAt: undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoing, onUndo: () => runUndo(undo) } : null;
  }

  return { outcome, show, dismiss, undoProp, undoing };
}
```

Edge to check against the old bars: they stamped `edits: selectionEdits` from the closure of the render that STARTED the action; `show` from that same render closes over the same `edits` — identical. Add `useUndoOutcome: ["show", "dismiss"]` to `STATE_HOOK_METHODS` and a detector case proving `const o = useUndoOutcome(...); start(async () => { await x(); o.show("m"); })` is flagged and the re-wrapped form is not.
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(bulk-bar): shared useUndoOutcome hook`.

### Tasks 4.2–4.5: Migrate the row-selection bars and the visit bar (one task, one commit each)

For each bar, delete its local `outcome` state, `undoing` transition, drop rule, `runUndo` and `undoProp`, and use the hook; keep forward actions, button logic and messages exactly. Run that bar's test file(s) unmodified after each; they must pass as they are.

- [ ] **4.2 Appointments** — `useUndoOutcome<ApptUndo, { restoredIds: string[]; notRestored: {id,reason}[] }>({ selectionEdits, undo: (u) => undoBulkAppointmentsAction({ batchId: u.batchId }), describeUndo: (r, u) => <today's keyOf-collapsing undoOutcomeMessage code> })`. Forward `run()` calls `outcome.show(msg, undo)` inside its existing `start(() => …)`.
- [ ] **4.3 Queue** — `undo: (u) => u.kind === "release" ? undoReleaseBatchAction(...) : undoBulkQueueAction(...)`; `describeUndo` branches the same way (PR 1's `releaseUndoMessage` vs `restoredTestCount` + `undoOutcomeMessage`). `S` is the union of both success shapes — narrow on `u.kind` inside `describeUndo`. `done()` and `release()` call `show`.
- [ ] **4.4 Messages** — `undo` picks status vs kind Undo by `u.action` (PR 3).
- [ ] **4.5 Visit Tests bar** — no `selectionEdits` (omit), `onError: "replace"`, `refreshAfterUndo: false`; `describeUndo` = today's hand-built "Undone — N test(s) … back to Ready for release." + `ALREADY_NOTIFIED` + "Not undone (n): reasons joined by '; '" text, unchanged; `onRelease`/`onUnrelease` call `dismiss()` where they called `setOutcome(null)`.

Each: **Step 1** migrate; **Step 2** `npx vitest run <bar tests> src/lib/react/transition-state.test.ts src/components/staff` — PASS with no test edits; **Step 3** commit `refactor(<bar>): outcome + Undo via useUndoOutcome`.

### Task 4.6: HMO claims bars

- [ ] **Step 1:** Rebuild `useHistoricHmoOutcome` (`hmo-claims-client.tsx:216-294`) on `useUndoOutcome<{ batchId; doneAt }, { restoredIds; notRestored }>({ undo: (u) => undoHistoricHmoBatchAction({ batchId: u.batchId }), describeUndo: (r) => undoOutcomeMessage({ one: "claim", many: "claims" }, { restored: r.restoredIds.length, notRestored: r.notRestored.map((n) => ({ label: `Claim ${n.id.slice(0, 8)}`, reason: n.reason })) }) })`, keeping its public return (`outcome`, `setOutcome`-equivalent, `undoProp`, `onActionSuccess`) so AllUnbilled / AllAging render code changes only where `outcome.batchId` is read (→ `outcome.undo`). `onActionSuccess` calls `show(historicBulkOutcomeMessage(kind, sent, result.updated), result.updated > 0 && result.batchId ? { batchId: result.batchId, doneAt: Date.now() } : null)`.
- [ ] **Step 2 (decision 2):** `provider-detail-client.tsx` — call `useHistoricHmoOutcome()` (export it if it is file-local; move it to `hmo-claims/_components/use-historic-hmo-outcome.ts` so both files import it), pass `onSuccess={(res) => onActionSuccess(<kind>, <sent>, res)}` to its historic modals exactly as AllUnbilled does, and render the same `BulkOutcomePanel` branches (inline inside its `FixedBottomBar` when rows are selected, standalone otherwise).
- [ ] **Step 3:** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims" src/lib/ui` + typecheck — PASS. **Commit** `refactor(hmo-claims): outcome + Undo via useUndoOutcome; provider page gains it`.

### Task 4.7: Browser, guide, gates, PR

- [ ] **Browser:** a full `npm run check:bulk-select` (every bar's existing checks are the regression proof for "no behaviour change") + **H5**: on a provider's detail page, Mark billed one historic fixture claim → outcome + ↶ Undo → claim unbilled again (same evidence as H1).
- [ ] **Guide** ≈ 456: the provider's page offers the same outcome panel and Undo.
- [ ] **Gates, whole-branch review, merge main, push, PR, stop for merge OK** — as Task 1.7.

---

## After the batch

Update memory `drmed-bulk-row-selection` (PR numbers, squash SHAs, guide versions, any browser-check lessons). Deferred list for the owner: the `reclaim_panel_members` grant revoke (next time a migration is needed anyway), bulk reply templates, inbox → Appointments "book the first one".
