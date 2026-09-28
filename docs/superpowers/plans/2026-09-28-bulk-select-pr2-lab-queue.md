# Bulk row selection — PR 2: Lab queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/staff/queue`, lab staff tick several single-test rows and Claim, Unclaim or Delete them in one go, with every row that could not be changed named in the result.

**Architecture:** Reuse the shared kit from PR 1 (`src/components/staff/row-selection/`, `src/lib/ui/bulk-selection.ts`) unchanged. Two new pure modules (`src/lib/queue/claim-eligibility.ts` — the per-row claim/unclaim predicates, shared by the single and bulk actions; `src/lib/queue/bulk-queue.ts` — row kinds, result type, result message). Three new server actions: `claimTestsAction` and `unclaimTestsAction` (per-row loops in `queue/actions.ts`) and `deleteTestRequestsManyAction` (a cross-visit coordinator over a new per-visit core in `queue-deletion.ts`). One new client bar (`queue/queue-bulk-bar.tsx`) and a checkbox column on the page. No migration.

**Tech Stack:** Next.js 16 App Router (RSC + Server Actions), Supabase (PostgREST), zod 4, Vitest (Node, static render — pure modules only), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-25-bulk-row-selection-design.md` §4 (kit), §6 (this PR), §8 (edge cases), §9 (acceptance).

---

## Ground rules for every task

- Work in `~/Claude/DRMed/.worktrees/bulk-select-queue` (branch `feat/bulk-select-queue`). Never `cd` to the main checkout.
- **Two kit rules from PR 1 — do not break them:** (1) never reset a selection by remounting the list (`SelectionProvider` resets itself on `resetKey`; do NOT put a React `key` on it or on anything wrapping the table); (2) never use `sticky` inside the staff shell — `BulkBar` is already `fixed`. Do not edit any file under `src/components/staff/row-selection/` or `src/lib/ui/bulk-selection.ts`.
- `"use server"` files may only export **async functions** (and types). Constants, schemas and sync helpers stay unexported or live in `src/lib/…`.
- A function exported from a `"use server"` file is a public endpoint. The per-visit delete core takes an already-authenticated session, so it is **not exported**.
- Every bulk write carries the state the operator saw as a predicate (claim: `status = requested` + `assigned_to is null`; unclaim: `status = in_progress` + `assigned_to = <holder the operator saw>`); a write that returns no row is a skip, never an error for the batch.
- Audit only rows a write RETURNED, one audit row per record, with `bulk_batch_size` in metadata.
- Every id the client sends ends up in exactly one of `changedIds` or `skipped`.
- Commit after each task with the message given. End every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (subagents: use your own model name in that line).
- Standing guard tests that WILL react to this PR — run them whenever you touch an action file:
  `npx vitest run src/lib/patients/write-guards.test.ts src/lib/visits/query-surfaces.test.ts`.
  If one fails, read its header comment ("FIXING A FAILURE") and do what it says; never weaken the test itself.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/queue/claim-eligibility.ts` | create | `evaluateClaim`, `evaluateUnclaim` + refusal strings (pure) |
| `src/lib/queue/claim-eligibility.test.ts` | create | unit tests |
| `src/lib/queue/bulk-queue.ts` | create | `QUEUE_KIND`, `queueRowKinds`, `BulkQueueResult`, `QueueRowInfo`, `bulkQueueMessage` (pure) |
| `src/lib/queue/bulk-queue.test.ts` | create | unit tests |
| `src/app/(staff)/staff/(dashboard)/queue/actions.ts` | modify | `claimTestAction`/`performUnclaim` use the pure predicates; add `claimTestsAction`, `unclaimTestsAction` |
| `src/lib/actions/visits/queue-deletion.ts` | modify | extract `deleteTestRequestsForVisit` core; add `deleteTestRequestsManyAction` |
| `src/lib/patients/write-guards.test.ts` | modify | EXEMPT entries for the new write functions |
| `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx` | create | the page's bar: Claim / Unclaim (optional reason) / Delete (required reason) |
| `src/app/(staff)/staff/(dashboard)/queue/page.tsx` | modify | provider, checkbox column, kinds, `rowsByKey`, bar |
| `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-result-templates/SKILL.md` | modify | docs |

---

### Task 1: Pure claim / unclaim predicates

**Files:**
- Create: `src/lib/queue/claim-eligibility.ts`
- Test: `src/lib/queue/claim-eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/queue/claim-eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  UNCLAIM_REFUSAL_ANY,
  UNCLAIM_REFUSAL_OWN,
  evaluateClaim,
  evaluateUnclaim,
  type ClaimCandidate,
} from "./claim-eligibility";

const PAID = { payment_status: "paid", hmo_provider_id: null };

function candidate(over: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    isPackageHeader: false,
    isDoctorLine: false,
    section: "hematology",
    visitDeleted: false,
    visit: PAID,
    ...over,
  };
}

describe("evaluateClaim", () => {
  it("lets a medtech claim a paid hematology test", () => {
    expect(evaluateClaim(candidate(), "medtech")).toEqual({ ok: true });
  });

  it("refuses a test on a deleted visit first", () => {
    const r = evaluateClaim(candidate({ visitDeleted: true, isPackageHeader: true }), "medtech");
    expect(r).toEqual({ ok: false, error: "This visit was deleted from the queue." });
  });

  it("refuses a package header", () => {
    expect(evaluateClaim(candidate({ isPackageHeader: true }), "admin")).toEqual({
      ok: false,
      error: "Package headers cannot be claimed — they have no work.",
    });
  });

  it("refuses a doctor line even for admin", () => {
    const r = evaluateClaim(candidate({ isDoctorLine: true, section: null }), "admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Mark done/);
  });

  it("refuses reception outright (no sections)", () => {
    expect(evaluateClaim(candidate(), "reception")).toEqual({
      ok: false,
      error: "This test is outside the sections you can claim.",
    });
  });

  it("refuses a medtech on an x-ray (outside their sections)", () => {
    expect(evaluateClaim(candidate({ section: "imaging_xray" }), "medtech")).toEqual({
      ok: false,
      error: "This test is outside the sections you can claim.",
    });
  });

  it("refuses admin and pathologist on an x-ray with the owner message", () => {
    for (const role of ["admin", "pathologist"] as const) {
      expect(evaluateClaim(candidate({ section: "imaging_xray" }), role)).toEqual({
        ok: false,
        error: "Only an X-ray technician can claim this test.",
      });
    }
  });

  it("lets the x-ray technician claim an x-ray", () => {
    expect(evaluateClaim(candidate({ section: "imaging_xray" }), "xray_technician")).toEqual({
      ok: true,
    });
  });

  it("refuses an unpaid non-HMO visit with the payment hint", () => {
    const r = evaluateClaim(
      candidate({ visit: { payment_status: "unpaid", hmo_provider_id: null } }),
      "medtech",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/waiting for payment/);
  });

  it("passes waived and HMO-covered visits", () => {
    expect(
      evaluateClaim(candidate({ visit: { payment_status: "waived", hmo_provider_id: null } }), "medtech"),
    ).toEqual({ ok: true });
    expect(
      evaluateClaim(candidate({ visit: { payment_status: "unpaid", hmo_provider_id: "hmo-1" } }), "medtech"),
    ).toEqual({ ok: true });
  });
});

describe("evaluateUnclaim", () => {
  const held = { status: "in_progress", assigned_to: "u1" };

  it("lets the holder unclaim their own test", () => {
    expect(evaluateUnclaim(held, "u1")).toEqual({ ok: true });
  });

  it("refuses someone else's test for a non-admin", () => {
    expect(evaluateUnclaim(held, "u2")).toEqual({ ok: false, error: UNCLAIM_REFUSAL_OWN });
  });

  it("lets admin (ownerId null) unclaim anyone's test", () => {
    expect(evaluateUnclaim(held, null)).toEqual({ ok: true });
  });

  it("refuses a test that is not in progress", () => {
    expect(evaluateUnclaim({ status: "result_uploaded", assigned_to: "u1" }, "u1")).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_OWN,
    });
    expect(evaluateUnclaim({ status: "requested", assigned_to: null }, null)).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_ANY,
    });
  });

  it("refuses an in-progress row with no holder", () => {
    expect(evaluateUnclaim({ status: "in_progress", assigned_to: null }, null)).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_ANY,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/queue/claim-eligibility.test.ts`
Expected: FAIL — `Failed to resolve import "./claim-eligibility"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/queue/claim-eligibility.ts`. The strings are copied verbatim from today's `claimTestAction` / `performUnclaim` — keep them byte-identical (the curly quotes around “Mark done” included):

```ts
// Per-row claim / unclaim predicates for the lab queue (spec §6). Shared by
// the single-row actions (claimTestAction, performUnclaim) and the bulk ones
// (claimTestsAction, unclaimTestsAction) in queue/actions.ts, so a row the
// bulk bar skips is refused for exactly the reason its own button would give.
// Pure: no I/O, so vitest pins every branch.

import type { StaffSession } from "@/lib/auth/require-staff";
import {
  canClaimSection,
  claimOwnerLabel,
  claimOwnerRole,
  sectionsForRole,
} from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { labQueueGate, type LabGateVisitShape } from "@/lib/visits/lab-gate";

type Role = StaffSession["role"];

export type Eligibility = { ok: true } | { ok: false; error: string };

export interface ClaimCandidate {
  isPackageHeader: boolean;
  /**
   * `isDoctorKind(services.kind)`. Computed by the CALLER next to its read,
   * not in here: query-surfaces.test.ts checks that every lab read of
   * test_requests has a doctor-kind marker in its own enclosing function.
   */
  isDoctorLine: boolean;
  section: string | null;
  visitDeleted: boolean;
  visit: LabGateVisitShape;
}

export function evaluateClaim(c: ClaimCandidate, role: Role): Eligibility {
  // Whole-visit deletes don't cascade deleted_at onto lines — check the
  // parent so a stale tab can't claim work on a deleted visit.
  if (c.visitDeleted) {
    return { ok: false, error: "This visit was deleted from the queue." };
  }
  if (c.isPackageHeader) {
    return { ok: false, error: "Package headers cannot be claimed — they have no work." };
  }
  // A consultation has no bench step: claimed, it would sit in in_progress
  // forever. The section gate can't refuse it for admin/pathologist (doctor
  // services carry a null section, which their unrestricted scope passes).
  if (c.isDoctorLine) {
    return {
      ok: false,
      error:
        "Consultations and procedures are completed on the visit page with “Mark done”, not claimed from the lab queue.",
    };
  }
  // RLS lets every lab role (and reception) write test_requests, so the
  // queue list's section filter is UX, not the guard. reception's [] denies.
  if (
    scopeToAllowedSections(
      [{ id: "", services: { section: c.section, name: "" } }],
      sectionsForRole(role),
    ).length === 0
  ) {
    return { ok: false, error: "This test is outside the sections you can claim." };
  }
  // Single-owner sections (x-ray → x-ray technician) keep admin/pathologist out.
  const owner = claimOwnerRole(c.section);
  if (owner && !canClaimSection(role, c.section)) {
    return { ok: false, error: `Only an ${claimOwnerLabel(owner)} can claim this test.` };
  }
  // Payment gate (item 10): the worklist hides these rows, but a stale tab
  // must not start lab work on an unpaid visit.
  const gate = labQueueGate(c.visit);
  if (!gate.ok) return { ok: false, error: gate.hint };
  return { ok: true };
}

export const UNCLAIM_REFUSAL_ANY = "Only claimed, in-progress tests can be unclaimed.";
export const UNCLAIM_REFUSAL_OWN =
  "You can only unclaim a test you currently hold that has no result yet.";

export interface UnclaimCandidate {
  status: string;
  assigned_to: string | null;
}

/**
 * `ownerId` null = admin (may hand back anyone's claim); otherwise the caller
 * must be the holder. Only an in-flight claim with no uploaded result
 * (`in_progress`) can be handed back.
 */
export function evaluateUnclaim(row: UnclaimCandidate, ownerId: string | null): Eligibility {
  const ok =
    row.status === "in_progress" &&
    row.assigned_to !== null &&
    (ownerId === null || row.assigned_to === ownerId);
  if (ok) return { ok: true };
  return { ok: false, error: ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/queue/claim-eligibility.test.ts`
Expected: PASS (15 tests). If `role-sections.ts` imports anything that breaks under Node, stop and report — do not mock around it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/claim-eligibility.ts src/lib/queue/claim-eligibility.test.ts
git commit -m "feat(queue): pure per-row claim/unclaim predicates"
```

---

### Task 2: Pure bulk-queue helpers (kinds, result type, message)

**Files:**
- Create: `src/lib/queue/bulk-queue.ts`
- Test: `src/lib/queue/bulk-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/queue/bulk-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { QUEUE_KIND, bulkQueueMessage, queueRowKinds, type QueueRowInfo } from "./bulk-queue";

const rows: Record<string, QueueRowInfo> = {
  a: { visitId: "v1", label: "CBC — Santos, Maria", assignedTo: null },
  b: { visitId: "v1", label: "Urinalysis — Santos, Maria", assignedTo: null },
  c: { visitId: "v2", label: "Chest X-ray — Cruz, Ana", assignedTo: null },
};

describe("queueRowKinds", () => {
  it("lists only the true flags, in bar order", () => {
    expect(queueRowKinds({ claimable: true, unclaimable: false, deletable: true })).toEqual([
      QUEUE_KIND.claim,
      QUEUE_KIND.delete,
    ]);
    expect(queueRowKinds({ claimable: false, unclaimable: false, deletable: false })).toEqual([]);
  });
});

describe("bulkQueueMessage", () => {
  it("says the plain count when everything changed", () => {
    expect(bulkQueueMessage("Claimed", 2, { changedIds: ["a", "b"], skipped: [] }, rows)).toBe(
      "Claimed 2 tests.",
    );
    expect(bulkQueueMessage("Claimed", 1, { changedIds: ["a"], skipped: [] }, rows)).toBe(
      "Claimed 1 test.",
    );
  });

  it("names every skipped row with its reason", () => {
    expect(
      bulkQueueMessage(
        "Claimed",
        3,
        {
          changedIds: ["a"],
          skipped: [
            { id: "b", reason: "Claimed by someone else or changed just now." },
            { id: "c", reason: "Only an X-ray technician can claim this test." },
          ],
        },
        rows,
      ),
    ).toBe(
      [
        "Claimed 1 of 3 tests.",
        "Not changed (2):",
        "• Urinalysis — Santos, Maria: Claimed by someone else or changed just now.",
        "• Chest X-ray — Cruz, Ana: Only an X-ray technician can claim this test.",
      ].join("\n"),
    );
  });

  it("says nothing changed when nothing did", () => {
    expect(
      bulkQueueMessage("Unclaimed", 1, { changedIds: [], skipped: [{ id: "a", reason: "Gone." }] }, rows),
    ).toBe(["Nothing unclaimed.", "Not changed (1):", "• CBC — Santos, Maria: Gone."].join("\n"));
  });

  it("caps the named list at five and counts the rest", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, reason: "Gone." }));
    const msg = bulkQueueMessage("Deleted", 7, { changedIds: [], skipped }, {});
    const lines = msg.split("\n");
    expect(lines[1]).toBe("Not changed (7):");
    expect(lines.filter((l) => l.startsWith("• A test"))).toHaveLength(5);
    expect(lines.at(-1)).toBe("• …and 2 more");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/queue/bulk-queue.test.ts`
Expected: FAIL — cannot resolve `./bulk-queue`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/queue/bulk-queue.ts`:

```ts
// Pure pieces of the lab queue's bulk bar (spec §6): the selection kinds a
// row carries, the server actions' result shape, and the message the bar
// shows afterwards. Lives in src/lib because "use server" modules may only
// export async functions and both sides need these.

export const QUEUE_KIND = {
  claim: "claimable",
  unclaim: "unclaimable",
  delete: "deletable",
} as const;
export type QueueKind = (typeof QUEUE_KIND)[keyof typeof QUEUE_KIND];

/** Kinds for one single-test row, from the same predicates that decide which buttons the row shows. */
export function queueRowKinds(flags: {
  claimable: boolean;
  unclaimable: boolean;
  deletable: boolean;
}): QueueKind[] {
  const kinds: QueueKind[] = [];
  if (flags.claimable) kinds.push(QUEUE_KIND.claim);
  if (flags.unclaimable) kinds.push(QUEUE_KIND.unclaim);
  if (flags.deletable) kinds.push(QUEUE_KIND.delete);
  return kinds;
}

export interface SkippedRow {
  id: string;
  reason: string;
}

/** Every id sent lands in exactly one of changedIds / skipped. */
export type BulkQueueResult =
  | { ok: true; changedIds: string[]; skipped: SkippedRow[] }
  | { ok: false; error: string };

/** What the bar knows about a selectable row — serialisable, built by the server page. */
export interface QueueRowInfo {
  visitId: string;
  /** "CBC — Santos, Maria": how the result message names the row. */
  label: string;
  /** The holder the operator SAW (unclaim sends it as a predicate); null when unclaimed. */
  assignedTo: string | null;
}

const NAMED_SKIPS = 5;

function tests(n: number): string {
  return `test${n === 1 ? "" : "s"}`;
}

/**
 * "Claimed 3 of 5 tests." plus one line per skipped row, naming it and why —
 * the first five, then "…and N more". `verb` is past tense, capitalised.
 */
export function bulkQueueMessage(
  verb: string,
  sentCount: number,
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[] },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string {
  const changed = result.changedIds.length;
  const head =
    changed === 0
      ? `Nothing ${verb.toLowerCase()}.`
      : changed === sentCount
        ? `${verb} ${changed} ${tests(changed)}.`
        : `${verb} ${changed} of ${sentCount} ${tests(sentCount)}.`;
  if (result.skipped.length === 0) return head;
  const lines = result.skipped
    .slice(0, NAMED_SKIPS)
    .map((s) => `• ${rowsByKey[s.id]?.label ?? "A test"}: ${s.reason}`);
  const more = result.skipped.length - NAMED_SKIPS;
  if (more > 0) lines.push(`• …and ${more} more`);
  return [head, `Not changed (${result.skipped.length}):`, ...lines].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/queue/bulk-queue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/bulk-queue.ts src/lib/queue/bulk-queue.test.ts
git commit -m "feat(queue): bulk-bar kinds, result type and outcome message"
```

---

### Task 3: Single claim / unclaim use the shared predicates (no behaviour change)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts` (`claimTestAction` gate block, `performUnclaim` preflight)

- [ ] **Step 1: Replace the gate block in `claimTestAction`**

In `claimTestAction`, keep the read and the `if (!testRequest) return { ok: false, error: "Test not found." };` line exactly as they are. Replace everything from the `// Whole-visit deletes don't cascade…` comment down to and including the payment-gate `if (!gate.ok) { … }` block with:

```ts
  // Every refusal lives in evaluateClaim (src/lib/queue/claim-eligibility.ts)
  // so the bulk claim refuses a row for exactly the same reason. isDoctorKind
  // stays HERE, beside the read (query-surfaces.test.ts looks for it).
  const verdict = evaluateClaim(
    {
      isPackageHeader: testRequest.is_package_header,
      isDoctorLine: isDoctorKind(testRequest.services.kind),
      section: testRequest.services.section,
      visitDeleted: testRequest.visits.deleted_at !== null,
      visit: testRequest.visits,
    },
    session.role,
  );
  if (!verdict.ok) return verdict;
```

The `// Only claim if currently 'requested'` write, the audit and the revalidates stay untouched.

- [ ] **Step 2: Use `evaluateUnclaim` in `performUnclaim`'s preflight**

Replace:

```ts
  const refusal =
    ownerId === null
      ? "Only claimed, in-progress tests can be unclaimed."
      : "You can only unclaim a test you currently hold that has no result yet.";
  if (
    before.some(
      (r) =>
        r.status !== "in_progress" ||
        r.assigned_to === null ||
        (ownerId !== null && r.assigned_to !== ownerId),
    )
  ) {
    return { ok: false, error: refusal };
  }
```

with:

```ts
  const refusal = ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN;
  if (before.some((r) => !evaluateUnclaim(r, ownerId).ok)) {
    return { ok: false, error: refusal };
  }
```

Nothing else in `performUnclaim` changes — it stays all-or-nothing (a chemistry PANEL depends on that).

- [ ] **Step 3: Fix imports**

Add:

```ts
import {
  UNCLAIM_REFUSAL_ANY,
  UNCLAIM_REFUSAL_OWN,
  evaluateClaim,
  evaluateUnclaim,
} from "@/lib/queue/claim-eligibility";
```

Remove imports that are now unused in this file (`labQueueGate`, `claimOwnerLabel`, `claimOwnerRole`, `sectionsForRole`, `scopeToAllowedSections` — check each with grep first; `canClaimSection`, `claimOwnerLabel` and `claimOwnerRole` are still used by `reassignTestAction`, so keep whichever still has a use). `npm run lint` will flag leftovers.

- [ ] **Step 4: Verify nothing moved**

Run: `npx vitest run src/lib/visits/query-surfaces.test.ts src/lib/patients/write-guards.test.ts src/lib/queue && npm run typecheck`
Expected: all PASS, typecheck clean. `git diff` must show no change to any user-facing string.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/actions.ts"
git commit -m "refactor(queue): single claim/unclaim share the pure per-row predicates"
```

---

### Task 4: `claimTestsAction` and `unclaimTestsAction`

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts` (append after `unclaimFromQueueAction`, i.e. after `LAB_CAPABLE_ROLES` is declared)
- Modify: `src/lib/patients/write-guards.test.ts` (EXEMPT)

- [ ] **Step 1: Add imports**

```ts
import { ipAndAgent } from "@/lib/server/action-helpers";
import type { BulkQueueResult, SkippedRow } from "@/lib/queue/bulk-queue";
```

(`z`, `MAX_BULK_SELECTION`, `translatePgError`, `isDoctorKind`, `audit`, `revalidatePath`, `createClient`, `requireActiveStaff` are already imported.)

- [ ] **Step 2: Append the two actions**

```ts
// ---------------------------------------------------------------------------
// Bulk claim / unclaim from the queue list's selection bar (spec §6).
// Per-row atomicity: each row is evaluated and written on its own, one skip
// never blocks the rest, and every id sent comes back in exactly one of
// changedIds / skipped. Independent single-test rows only — chemistry panels
// get no checkbox, so performUnclaim's all-or-nothing panel contract above is
// untouched.
// ---------------------------------------------------------------------------

const NOT_LAB_STAFF = "Only lab staff can claim or unclaim tests from the queue.";
const BULK_INPUT_ERROR = "Could not read the selection — refresh the queue and try again.";

const BulkClaimSchema = z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION);

export async function claimTestsAction(input: unknown): Promise<BulkQueueResult> {
  // Role before anything candidate-dependent (spec §9 item 5).
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkClaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const ids = Array.from(new Set(parsed.data));

  const supabase = await createClient();
  const { data: rows, error: readError } = await supabase
    .from("test_requests")
    .select(
      "id, is_package_header, services!inner ( kind, section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("id", ids)
    // A queue-deleted line (0125) reads as not found.
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const changed: Array<{ id: string; visit_id: string }> = [];
  const skipped: SkippedRow[] = [];
  const startedAt = new Date().toISOString();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue or no longer exists." });
      continue;
    }
    const verdict = evaluateClaim(
      {
        isPackageHeader: row.is_package_header,
        isDoctorLine: isDoctorKind(row.services.kind),
        section: row.services.section,
        visitDeleted: row.visits.deleted_at !== null,
        visit: row.visits,
      },
      session.role,
    );
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    // The state the operator saw: requested, nobody holding it.
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "in_progress", assigned_to: session.user_id, started_at: startedAt })
      .eq("id", id)
      .eq("status", "requested")
      .is("assigned_to", null)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Claimed by someone else or changed just now." });
    } else {
      changed.push(data);
    }
  }

  const { ip, ua } = await ipAndAgent();
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: row.visit_id, bulk_batch_size: ids.length },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped };
}

const BulkUnclaimSchema = z.object({
  items: z
    .array(
      z.object({
        testRequestId: z.string().uuid(),
        // The holder the operator SAW — the write only lands while it still holds.
        assignedTo: z.string().uuid(),
      }),
    )
    .min(1)
    .max(MAX_BULK_SELECTION),
  reason: z.string().max(500).optional(),
});

export async function unclaimTestsAction(input: unknown): Promise<BulkQueueResult> {
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: NOT_LAB_STAFF };
  }
  const parsed = BulkUnclaimSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  // First occurrence of an id wins.
  const seenHolder = new Map<string, string>();
  for (const item of parsed.data.items) {
    if (!seenHolder.has(item.testRequestId)) seenHolder.set(item.testRequestId, item.assignedTo);
  }
  const ids = [...seenHolder.keys()];
  const reason = parsed.data.reason?.trim() || null;
  // Same power as the row's Unclaim: admin anyone's, everyone else their own.
  const ownerId = session.role === "admin" ? null : session.user_id;

  const supabase = await createClient();
  const { data: before, error: readError } = await supabase
    .from("test_requests")
    .select("id, assigned_to, status, visits!inner ( id )")
    .in("id", ids)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  const byId = new Map((before ?? []).map((r) => [r.id, r]));

  const changed: Array<{ id: string; visit_id: string; previous: string }> = [];
  const skipped: SkippedRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const saw = seenHolder.get(id)!;
    if (!row) {
      skipped.push({ id, reason: "Deleted from the queue — restore it before unclaiming it." });
      continue;
    }
    const verdict = evaluateUnclaim(row, ownerId);
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.error });
      continue;
    }
    if (row.assigned_to !== saw) {
      skipped.push({ id, reason: "Someone else holds this test now — refresh the queue." });
      continue;
    }
    const { data, error } = await supabase
      .from("test_requests")
      .update({ status: "requested", assigned_to: null, started_at: null })
      .eq("id", id)
      .eq("status", "in_progress")
      .eq("assigned_to", saw)
      .is("deleted_at", null)
      .select("id, visit_id")
      .maybeSingle();
    if (error) {
      skipped.push({ id, reason: translatePgError(error) });
    } else if (!data) {
      skipped.push({ id, reason: "Changed just now — refresh the queue." });
    } else {
      changed.push({ id: data.id, visit_id: data.visit_id, previous: saw });
    }
  }

  // Same audit shape as performUnclaim, so the queue's Remarks column
  // (queue_claim_remarks, 0160) reads bulk unclaims unchanged.
  const { ip, ua } = await ipAndAgent();
  for (const row of changed) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.unclaimed",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: row.visit_id,
        previous_assignee: row.previous,
        reason,
        self_service: ownerId !== null,
        bulk_batch_size: ids.length,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  if (changed.length > 0) {
    revalidatePath("/staff/queue");
    for (const row of changed) revalidatePath(`/staff/queue/${row.id}`);
  }
  return { ok: true, changedIds: changed.map((r) => r.id), skipped };
}
```

Check before moving on: `ipAndAgent()` returns `{ ip, ua }` (read `src/lib/server/action-helpers.ts:11` to confirm the field names). If `testRequest.visits` does not satisfy `LabGateVisitShape` in the generated types (it has `payment_status` and `hmo_provider_id`), pass `{ payment_status: row.visits.payment_status, hmo_provider_id: row.visits.hmo_provider_id }` explicitly — same in Task 3.

- [ ] **Step 3: EXEMPT entries in the write guard**

In `src/lib/patients/write-guards.test.ts`, directly under the existing `performUnclaim` EXEMPT entry, add:

```ts
  [`src/app/(staff)/staff/(dashboard)/queue/actions.ts:claimTestsAction`]:
    "Bulk form of claimTestAction — claiming does not bill or release, and a deleted/merged patient has no open lines to claim.",
  [`src/app/(staff)/staff/(dashboard)/queue/actions.ts:unclaimTestsAction`]:
    "Bulk form of the queue list's Unclaim — handing a claim back reduces work, same reasoning as performUnclaim.",
```

- [ ] **Step 4: Run the guards, typecheck, lint**

Run: `npx vitest run src/lib/patients/write-guards.test.ts src/lib/visits/query-surfaces.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean. If query-surfaces flags either new read chain, follow the test's FIXING guidance (both reads are `live` + `lab` in an already-classified file; the claim read carries `isDoctorKind` in its function, the unclaim pre-read does not touch `services`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/actions.ts" src/lib/patients/write-guards.test.ts
git commit -m "feat(queue): bulk claim and unclaim actions with per-row predicates and named skips"
```

---

### Task 5: Cross-visit bulk delete

**Files:**
- Modify: `src/lib/actions/visits/queue-deletion.ts`
- Modify: `src/lib/patients/write-guards.test.ts` (EXEMPT key moves to the core)

- [ ] **Step 1: Imports**

Add to `queue-deletion.ts`:

```ts
import { z } from "zod";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { BulkQueueResult, SkippedRow } from "@/lib/queue/bulk-queue";
```

- [ ] **Step 2: Extract the per-visit core**

Replace the whole `deleteTestRequestsAction` function with the core plus a thin wrapper. The wrapper keeps its exact signature, checks, messages and `{ ok: true, count }` return, so its callers (`QueueDeleteDialog`, the visit page) are unchanged:

```ts
type VisitDeleteOutcome =
  | { ok: true; deletedIds: string[] }
  | { ok: false; error: string };

// Per-visit core shared by deleteTestRequestsAction (one visit) and
// deleteTestRequestsManyAction (a queue selection across visits). NOT
// exported: every export of a "use server" file is a public endpoint, and
// this trusts the session + reason its caller already checked.
async function deleteTestRequestsForVisit(
  session: StaffSession,
  visitId: string,
  testRequestIds: string[],
  reason: string,
  bulkBatchSize?: number,
): Promise<VisitDeleteOutcome> {
  const admin = createAdminClient();
  const { data: candidates } = await admin
    .from("test_requests")
    .select(
      "id, final_price_php, is_package_header, visits!inner ( patient_id, deleted_at ), services ( name, code )",
    )
    .in("id", testRequestIds)
    .eq("visit_id", visitId)
    .is("deleted_at", null);
  const rows = candidates ?? [];
  if (rows.length === 0) {
    return { ok: false, error: "None of the selected tests can be deleted." };
  }
  if (rows.some((r) => r.visits.deleted_at !== null)) {
    return { ok: false, error: "Visit is already deleted." };
  }

  // One UPDATE per visit — the 0125 guard raises P0042/P0043/P0044 for the
  // whole statement, so a mixed selection on one visit fails atomically
  // rather than half-deleting.
  const { data: deleted, error } = await admin
    .from("test_requests")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: session.user_id,
      delete_reason: reason,
    })
    .in(
      "id",
      rows.map((r) => r.id),
    )
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "None of the selected tests can be deleted." };
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const { ip, ua } = await ipAndAgent();
  for (const row of deleted) {
    const info = rowById.get(row.id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: info?.visits.patient_id ?? null,
      action: "test_request.deleted",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: {
        visit_id: visitId,
        reason,
        service_name: info?.services?.name ?? null,
        service_code: info?.services?.code ?? null,
        final_price_php:
          info?.final_price_php != null ? Number(info.final_price_php) : null,
        is_package_header: info?.is_package_header ?? false,
        bulk: deleted.length > 1,
        ...(bulkBatchSize !== undefined ? { bulk_batch_size: bulkBatchSize } : {}),
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  revalidateQueueSurfaces(visitId);
  return { ok: true, deletedIds: deleted.map((r) => r.id) };
}

export async function deleteTestRequestsAction(
  visitId: string,
  testRequestIds: string[],
  reason: string,
): Promise<QueueDeletionResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = parseReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }
  if (testRequestIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      error: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    };
  }
  const outcome = await deleteTestRequestsForVisit(
    session,
    visitId,
    testRequestIds,
    parsed.reason,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, count: outcome.deletedIds.length };
}
```

Compare against the original with `git diff` before moving on: the select string, both refusal messages, the update, and every audit metadata key except the new optional `bulk_batch_size` must be identical.

- [ ] **Step 3: Add the coordinator**

Directly after `deleteTestRequestsAction`:

```ts
const ManyDeleteSchema = z.object({
  testRequestIds: z
    .array(z.string().uuid({ message: "Could not read the selection — refresh the queue and try again." }))
    .min(1, { message: "Nothing to delete — no tests were selected." })
    .max(MAX_BULK_SELECTION, {
      message: `Too many tests selected — the limit is ${MAX_BULK_SELECTION} per action.`,
    }),
  reason: z.string(),
});

// The lab queue's bulk Delete (spec §6): a selection that can span visits.
// Order matters — role, then the input's shape and the reason, and only then
// the service-role read — so an empty or unknown-id batch from a caller
// without the role gets the role error, never a candidate-dependent message.
// Each visit is its own atomic statement (deleteTestRequestsForVisit): a
// refused visit (paid, HMO-claimed, shared report…) is reported as skipped
// with the translated reason, and visits already committed stay committed.
export async function deleteTestRequestsManyAction(input: unknown): Promise<BulkQueueResult> {
  const { session, error: roleError } = await requireQueueDeleteStaff();
  if (!session) return { ok: false, error: roleError };
  const shape = ManyDeleteSchema.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      error:
        shape.error.issues[0]?.message ??
        "Could not read the selection — refresh the queue and try again.",
    };
  }
  const parsed = parseReason(shape.data.reason);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ids = Array.from(new Set(shape.data.testRequestIds));

  const admin = createAdminClient();
  const { data: candidates, error: readError } = await admin
    .from("test_requests")
    .select("id, visit_id")
    .in("id", ids)
    .is("deleted_at", null);
  if (readError) return { ok: false, error: translatePgError(readError) };
  if (!candidates || candidates.length === 0) {
    return {
      ok: false,
      error: "Nothing to delete — these tests were already deleted or no longer exist.",
    };
  }

  const visitOf = new Map(candidates.map((c) => [c.id, c.visit_id]));
  const byVisit = new Map<string, string[]>();
  const skipped: SkippedRow[] = [];
  for (const id of ids) {
    const visitId = visitOf.get(id);
    if (!visitId) {
      skipped.push({ id, reason: "Already deleted or no longer exists." });
      continue;
    }
    const group = byVisit.get(visitId);
    if (group) group.push(id);
    else byVisit.set(visitId, [id]);
  }

  const changedIds: string[] = [];
  for (const [visitId, groupIds] of byVisit) {
    const outcome = await deleteTestRequestsForVisit(
      session,
      visitId,
      groupIds,
      parsed.reason,
      ids.length,
    );
    if (!outcome.ok) {
      for (const id of groupIds) skipped.push({ id, reason: outcome.error });
      continue;
    }
    const done = new Set(outcome.deletedIds);
    for (const id of groupIds) {
      if (done.has(id)) changedIds.push(id);
      else skipped.push({ id, reason: "Already deleted or not deletable." });
    }
  }
  return { ok: true, changedIds, skipped };
}
```

Note: `changedIds` is built from `groupIds ∩ deletedIds` so it only ever holds ids the client sent (a package header's components cascade in the DB trigger and are never returned by `.select("id")` anyway).

- [ ] **Step 4: Move the EXEMPT key**

In `src/lib/patients/write-guards.test.ts` replace the entry

```ts
  [`src/lib/actions/visits/queue-deletion.ts:deleteTestRequestsAction`]:
    "Deletes stay unguarded by design (Task 23) — they remove work, never put it back.",
```

with

```ts
  [`src/lib/actions/visits/queue-deletion.ts:deleteTestRequestsForVisit`]:
    "Deletes stay unguarded by design (Task 23) — they remove work, never put it back. Shared core of deleteTestRequestsAction and deleteTestRequestsManyAction.",
```

- [ ] **Step 5: Run guards, typecheck, lint**

Run: `npx vitest run src/lib/patients/write-guards.test.ts src/lib/visits/query-surfaces.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean. `queue-deletion.ts` is classified `all` + lifecycle `any` — the new read must NOT carry a doctor-kind filter (the test's "no over-filtering" rule). If write-guards reports the wrapper still needs an entry, add it back with the same reason rather than editing the scanner.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/visits/queue-deletion.ts src/lib/patients/write-guards.test.ts
git commit -m "feat(queue): cross-visit bulk delete over a shared per-visit core"
```

---

### Task 6: The queue's bulk bar

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import { deleteTestRequestsManyAction } from "@/lib/actions/visits/queue-deletion";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  type BulkQueueResult,
  type QueueRowInfo,
} from "@/lib/queue/bulk-queue";
import { claimTestsAction, unclaimTestsAction } from "./actions";

interface Props {
  // Every selectable single-test row the page rendered, keyed by test id.
  rowsByKey: Record<string, QueueRowInfo>;
  // The page shows at least one chemistry panel card (no checkbox, spec §6).
  hasPanels: boolean;
}

type Panel = null | "unclaim" | "delete";

// The lab queue's selection bar: Claim · Unclaim (optional reason) · Delete
// (required reason, red confirm — QueueDeleteDialog's wording). Each button
// acts on the selected rows that carry its kind; the server re-proves every
// row and reports the ones it skipped by name.
export function QueueBulkBar({ rowsByKey, hasPanels }: Props) {
  const { keysByKind, clearKeys } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const known = (keys: string[] | undefined) =>
    (keys ?? []).filter((key) => rowsByKey[key] !== undefined);
  const claimKeys = known(keysByKind[QUEUE_KIND.claim]);
  const unclaimKeys = known(keysByKind[QUEUE_KIND.unclaim]).filter(
    (key) => rowsByKey[key]!.assignedTo !== null,
  );
  const deleteKeys = known(keysByKind[QUEUE_KIND.delete]);

  function closePanel() {
    setPanel(null);
    setReason("");
    setErr(null);
  }

  function done(verb: string, keys: string[], result: BulkQueueResult, inPanel: boolean) {
    if (!result.ok) {
      // Nothing was attempted (role / input / reason) — keep the selection.
      if (inPanel) setErr(result.error);
      else alert(result.error);
      return;
    }
    alert(bulkQueueMessage(verb, keys.length, result, rowsByKey));
    // Pruning wins (spec §4): clear everything sent; the alert is the record.
    clearKeys(keys);
    closePanel();
    router.refresh();
  }

  function claim() {
    if (pending || claimKeys.length === 0) return;
    const keys = claimKeys;
    start(async () => done("Claimed", keys, await claimTestsAction(keys), false));
  }

  function unclaim() {
    if (pending || unclaimKeys.length === 0) return;
    const keys = unclaimKeys;
    const items = keys.map((key) => ({
      testRequestId: key,
      assignedTo: rowsByKey[key]!.assignedTo!,
    }));
    start(async () =>
      done(
        "Unclaimed",
        keys,
        await unclaimTestsAction({ items, reason: reason.trim() || undefined }),
        true,
      ),
    );
  }

  function remove() {
    if (pending || deleteKeys.length === 0) return;
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    const keys = deleteKeys;
    start(async () =>
      done(
        "Deleted",
        keys,
        await deleteTestRequestsManyAction({ testRequestIds: keys, reason: reason.trim() }),
        true,
      ),
    );
  }

  const panelCount = panel === "unclaim" ? unclaimKeys.length : panel === "delete" ? deleteKeys.length : 0;
  const n = (count: number) => `${count} test${count === 1 ? "" : "s"}`;

  return (
    <BulkBar noun="test">
      {hasPanels ? (
        <span className="text-[11px] text-[color:var(--color-brand-text-soft)]">
          Chemistry panels are claimed from their own page.
        </span>
      ) : null}
      {claimKeys.length > 0 ? (
        <Button type="button" size="sm" variant="brand" disabled={pending} onClick={claim}>
          {pending ? "Working…" : `Claim (${claimKeys.length})`}
        </Button>
      ) : null}
      {unclaimKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-expanded={panel === "unclaim"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "unclaim" ? null : "unclaim");
          }}
        >
          Unclaim ({unclaimKeys.length})
        </Button>
      ) : null}
      {deleteKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          aria-expanded={panel === "delete"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "delete" ? null : "delete");
          }}
        >
          Delete ({deleteKeys.length})
        </Button>
      ) : null}
      {panel !== null && panelCount > 0 ? (
        <div className="basis-full space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
          <p className="text-[color:var(--color-brand-text-mid)]">
            {panel === "unclaim" ? (
              <>
                Put {n(panelCount)} back in the queue for anyone in the section to claim.
                Only possible while no result has been uploaded.
              </>
            ) : (
              <>
                Remove {n(panelCount)} from the queue. Nothing is billed for a deleted
                entry, each can be restored later, and the reason is audit-logged.
              </>
            )}
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closePanel();
            }}
            maxLength={500}
            placeholder={panel === "unclaim" ? "Reason (optional)…" : "Reason (required)…"}
            aria-label={panel === "unclaim" ? "Reason for unclaiming" : "Reason for deleting"}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          {err ? (
            <p role="alert" className="text-red-600">
              {err}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={panel === "unclaim" ? unclaim : remove}
              disabled={pending}
              className={`min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50 ${
                panel === "delete" ? "bg-red-700" : "bg-[color:var(--color-brand-navy)]"
              }`}
            >
              {pending
                ? panel === "delete"
                  ? "Deleting…"
                  : "Unclaiming…"
                : panel === "delete"
                  ? `Confirm delete (${panelCount})`
                  : `Confirm unclaim (${panelCount})`}
            </button>
            <button
              type="button"
              onClick={closePanel}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </BulkBar>
  );
}
```

Notes for the implementer:
- `alert()` for results matches PR 1's `appointments-bulk-bar.tsx` and the row `ClaimButton`. The bar unmounts at count 0 (after `clearKeys`), so an inline success message would vanish — that is why it is an alert.
- The BulkBar's own Escape handler already ignores Escape inside a text field; the textarea's `onKeyDown` closes the panel instead.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/queue-bulk-bar.tsx"
git commit -m "feat(queue): selection bar with claim, unclaim and delete"
```

---

### Task 7: Wire the page

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/page.tsx`

- [ ] **Step 1: Imports**

```ts
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";
import { queueRowKinds, type QueueRowInfo } from "@/lib/queue/bulk-queue";
import { QueueBulkBar } from "./queue-bulk-bar";
```

- [ ] **Step 2: Kinds, entries, rowsByKey, resetKey**

Directly after the `canUnclaim` definition add:

```ts
  // Bulk selection (spec §6). Reception never gets checkboxes (it only sees
  // Released today), and Released today is a record, not a worklist. A row's
  // kinds come from the SAME predicates that render its buttons below, so
  // the bar never offers what the row itself wouldn't. Chemistry panel cards
  // get no checkbox: paging happens before the fold, so a visible card can
  // hold part of a panel.
  const selectable = !receptionView && !releasedTab;
  const singleKinds = (card: QueueCardSingle) =>
    queueRowKinds({
      claimable: card.status === "requested" && canClaimSection(session.role, card.section),
      unclaimable: canUnclaim(card),
      deletable: card.canDelete,
    });
  const selectionEntries: SelectionEntry[] = [];
  const rowsByKey: Record<string, QueueRowInfo> = {};
  if (selectable) {
    for (const card of matched) {
      if (card.kind !== "single") continue;
      const kinds = singleKinds(card);
      if (kinds.length === 0) continue;
      selectionEntries.push({ rowKey: card.testRequestId, kinds, weight: 1 });
      rowsByKey[card.testRequestId] = {
        visitId: card.visitId,
        label: `${card.label} — ${card.patientName}`,
        assignedTo: card.claimedBy,
      };
    }
  }
  const hasPanels = matched.some((card) => card.kind === "grouped");
  // Any change to what the list shows or its order drops the selection —
  // SelectionProvider resets itself on this string WITHOUT remounting the
  // table (never put a React key on the provider).
  const selectionResetKey = [
    filter,
    mineOnly ? "1" : "",
    start,
    end,
    q,
    visit,
    sort.key,
    sort.dir,
    String(page),
    String(size),
  ].join("|");
```

- [ ] **Step 3: Wrap the table and add the bar**

Wrap the `<Panel className="overflow-x-auto">…</Panel>` block (only the table panel — `ListPagination` stays outside) in the provider, and render the bar inside it after the panel:

```tsx
      <SelectionProvider resetKey={selectionResetKey}>
        <Panel className="overflow-x-auto">
          {/* …table unchanged except the edits in Step 4… */}
        </Panel>
        {selectable ? <QueueBulkBar rowsByKey={rowsByKey} hasPanels={hasPanels} /> : null}
      </SelectionProvider>
```

- [ ] **Step 4: Checkbox column**

1. In `<thead><tr>`, as the FIRST cell:

```tsx
              {selectable ? (
                <th className="w-12 px-2 py-3">
                  <SelectAllCheckbox
                    entries={selectionEntries}
                    label="Select all tests on this page"
                  />
                </th>
              ) : null}
```

2. The empty-state row: `colSpan={receptionView ? 6 : 7}` → `colSpan={(receptionView ? 6 : 7) + (selectable ? 1 : 0)}`.

3. Single-card row: compute kinds at the top of the `if (card.kind === "single") {` branch — `const kinds = selectable ? singleKinds(card) : [];` — and add as the row's FIRST cell:

```tsx
                      {selectable ? (
                        <td className="px-2 py-3 align-middle">
                          {kinds.length > 0 ? (
                            <RowSelectCheckbox
                              rowKey={card.testRequestId}
                              kinds={kinds}
                              label={`${card.label}, ${card.patientName}`}
                            />
                          ) : null}
                        </td>
                      ) : null}
```

4. Grouped-card row, FIRST cell:

```tsx
                    {selectable ? <td className="px-2 py-3" aria-hidden /> : null}
```

Do not touch the per-row Claim / Unclaim / Delete controls — they stay exactly as they are.

- [ ] **Step 5: Full local checks**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS / clean. Record the vitest totals for the PR body.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/page.tsx"
git commit -m "feat(queue): tick single-test rows and act on them from the selection bar"
```

---

### Task 8: Docs, guide and skills

**Files:**
- Modify: `docs/drmed-user-guide.html` (§4.2 The queue; admin "Unclaim or reassign" line ~1082)
- Modify: `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-result-templates/SKILL.md`
- Modify: `CLAUDE.md` (only if the guide version changes)

- [ ] **Step 1: Guide §4.2**

In the `<dl>` of §4.2 (line ~822), extend "Row buttons":

```html
      <dt>Row buttons</dt><dd><kbd class="ui">Claim</kbd> · <kbd class="ui">Unclaim</kbd> (on a test you hold; an Admin sees it on every claimed test) · tick boxes at the start of each single-test row → a bar at the bottom of the page acts on all ticked tests</dd>
```

After the "Claimed the wrong one?" tip (line ~830), add:

```html
    <div class="note tip"><span class="k">Several tests at once</span><div><p>Tick the boxes at the start of the rows (the box in the header ticks every test on the page). A bar appears at the bottom with only what applies to what you ticked: <kbd class="ui">Claim</kbd>, <kbd class="ui">Unclaim</kbd> (type an optional reason, then <kbd class="ui">Confirm unclaim</kbd>) and, for Admins on unpaid entries, <kbd class="ui">Delete</kbd> (a reason is required, then <kbd class="ui">Confirm delete</kbd>). Up to 100 tests at a time. Changing the tab, filters, sort or page clears the ticks; <kbd>Esc</kbd> clears them too.</p><p>Each test is checked again when you press the button. Any test that changed in the meantime — claimed by a colleague, already unclaimed, on a visit that is now paid — is left alone, and the message afterwards names it and says why. Chemistry panels have no tick box: claim or unclaim a panel from its own page.</p></div></div>
```

Check every label against the code you shipped (`Confirm unclaim (N)`, `Confirm delete (N)` render with a count — the guide names the button without it, which matches how the guide writes other counted buttons; grep `Confirm delete` in the guide to confirm that convention).

- [ ] **Step 2: Guide version — collision-safe**

Run `git fetch -q origin && git show origin/main:docs/drmed-user-guide.html | grep -o 'User guide · v[0-9.]*'`. Bump to the next minor above what origin/main has NOW (e.g. v2.33 → v2.34) in the three places PR 1 changed (`toc-tag`, the footer `<p>drmed.ph User Guide · v…`, and `CLAUDE.md`'s guide line), with today's date. Re-check this right before opening the PR (Task 10) — sibling sessions bump it too.

- [ ] **Step 3: Skills**

In `.claude/skills/drmed-staff-ui/SKILL.md`, "Multi-select on a list" paragraph: change `BulkBar` (sticky bottom, count, Clear, Escape) to `BulkBar` (**fixed** bottom — never `sticky` inside the staff shell, `<main>` is a scroll container; count, Clear, Escape), and add after the appointments live example: `Second example: the lab queue — queue/queue-bulk-bar.tsx + src/lib/queue/{bulk-queue,claim-eligibility}.ts (per-row loops, named skips, cross-visit delete over a per-visit core).` Also add: `SelectionProvider resets itself on resetKey — never put a React key on it (a remount wipes sibling client state, e.g. the no-show Undo banner).`

In `.claude/skills/drmed-result-templates/SKILL.md`, in the "Claims are section-scoped server-side" bullet, add: `Every claim refusal now lives in evaluateClaim (src/lib/queue/claim-eligibility.ts), shared by claimTestAction and the bulk claimTestsAction; unclaim's per-row rule is evaluateUnclaim, shared by performUnclaim (still all-or-nothing for panels) and unclaimTestsAction (per row).`

- [ ] **Step 4: Commit**

```bash
git add docs/drmed-user-guide.html CLAUDE.md .claude/skills/drmed-staff-ui/SKILL.md .claude/skills/drmed-result-templates/SKILL.md
git commit -m "docs: lab queue bulk claim/unclaim/delete in the guide and skills"
```

---

### Task 9: Browser acceptance checklist (spec §9) on the local stack

Controller-run (not a code task). Record results in the PR body.

**Setup**
- Local Supabase must be up (`supabase status`; OrbStack, never Docker Desktop). Other sessions reset the shared local DB: if sign-in bounces or data is missing, `npm run seed:test`, then make `inactive@drmed.ph` an active **medtech** (`update staff_profiles set is_active = true, role = 'medtech' where id = (select id from auth.users where email = 'inactive@drmed.ph')`), and seed fixtures with SQL against the local DB: at least 2 paid visits with 3+ single-test lab lines each (hematology/urinalysis), 1 paid visit with an x-ray line, 1 unpaid visit with a line (for the admin Pending/delete checks), and one chemistry panel.
- Dev server on port 3007 from the worktree (`PORT=3007 npm run dev`, backgrounded, log to `tmp/dev.log`).
- Browser: Playwright MCP if free; otherwise headless Chrome through the worktree's `playwright-core` with a script in gitignored `tmp/`. Sign in with email + password. Prefer DOM/text assertions (`evaluate`, snapshot); take at most two screenshots (bar pinned at desktop; 390px).

**Checks** (spec §9 numbering)
1. Select-all → header indeterminate after unticking one → all again. A panel row has no checkbox; the bar shows "Chemistry panels are claimed from their own page."
2. Escape clears; Escape inside the Unclaim/Delete reason box closes the panel and keeps the selection.
3. Changing tab, sort, page size, and applying a search each drop the selection — and the bar never uses `sticky` (fixed; it stays in the viewport while scrolling a long list).
4. Two sessions (admin + medtech): medtech ticks 3 requested rows; admin claims one of them from its row; medtech presses Claim (3) → message "Claimed 2 of 3 tests." naming the third "Claimed by someone else or changed just now."; `audit_log` has exactly 2 new `test_request.claimed` rows for the medtech, each with `bulk_batch_size = 3`. Same pattern for Unclaim (admin ticks 2 held rows, the holder unclaims one first → 1 of 2).
5. Reception (flip the second user to reception): lands on Released today with no checkbox column and no bar. The server-side order (role check before input parsing and before any read, so `[]` and unknown uuids get the role error) is verified by reading the three actions and noted in the PR — server actions can't be called from a plain script without the build's action ids. Also as medtech: a medtech has no Delete button (not a delete role).
6. x-ray row: admin sees no checkbox on a requested x-ray (no kinds); medtech never sees it. Delete across two visits where the second visit is paid (tick an unpaid row, then pay that visit in another tab before confirming) → first visit's rows deleted, second reported skipped with the translated message. The chemistry panel's own Unclaim still refuses a partly ineligible panel (unchanged path).
7. 390px: bar visible and wraps, checkboxes 44px, no horizontal page scroll added (`document.documentElement.scrollWidth <= innerWidth`).

---

### Task 10: Codex review, fixes, PR

Controller-run.

- [ ] `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"` then ONE `/codex-review astra high base origin/main`, adding `src/components/staff/row-selection/selection-context.tsx` and `src/components/staff/row-selection/bulk-bar.tsx` as context files (Codex never saw PR 1's last two fixes: selection reset without remount; the fixed bar). Never pipe the helper; open the report and confirm `Status: Completed` before trusting it.
- [ ] Verify each finding against the code (superpowers:receiving-code-review); fix confirmed ones with Sonnet subagents, re-run `npm test && npm run typecheck && npm run lint`.
- [ ] Re-check the guide version against origin/main (Task 8 Step 2), push, open the PR (body: summary, test totals, §9 checklist results, "no migration"), end the body with the Claude Code line. Stop for the owner's merge OK.
