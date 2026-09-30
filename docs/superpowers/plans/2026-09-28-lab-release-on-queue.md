# Lab Release on the Queue — Implementation Plan (rev 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use **Sonnet** subagents.

**Goal:** Let the lab (medtech, X-ray technician, pathologist, admin) release — and undo a release of — finished results from the lab Queue, where they already work, instead of only from the visit page (which medtech has no sidebar route to since 2026-09-24 and reception is not allowed to release from).

**Architecture:** No schema change, no migration, no RLS change. The visit page's release write is extracted into one server-only core (`releaseRows`) that returns the **authoritative** released ids from `UPDATE … RETURNING`; `releaseSelectedAction` keeps its exact behaviour on top of it, and a new cross-visit queue action `releaseTestsAction` uses it too. A pure eligibility evaluator (`evaluateRelease`) and a pure whole-report planner (`planReportRelease`) are shared by every surface, so a disabled button, a skipped bulk row and a refused action give the same reason. A combined (chemistry) report is released only when every test on it can be released; the patient is notified only for a report that ended fully released. UI on: bench page, consolidated report page, Pending release tab (row, panel, bulk incl. panels), Released today (Undo shortcut); plus dashboards, a reception bell alert, copy fixes and the user guide.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Supabase (RLS + admin clients), Supabase Realtime, Vitest (+ jsdom/Testing Library), Tailwind.

**Worktree / branch:** `/Users/jamila/Claude/DRMed/.worktrees/lab-release-on-queue`, `feat/lab-release-on-queue` (from `origin/main` @ `3576b515`).

---

## Background the implementer needs

- **Who may release.** `canActOnResult(role, section)` (`src/lib/visits/line-visibility.ts`) on `sectionsForRole` (`src/lib/auth/role-sections.ts`): reception `[]` = **deny**; medtech = chemistry/hematology/immunology/urinalysis/microbiology/send_out; xray_technician = imaging_*; pathologist/admin `null` = unrestricted. Reception must NEVER get a release or undo control (owner decision 2026-09-15). `[]` is a deny everywhere. RLS on `test_requests` is role-only and does NOT enforce section — the app checks are the guard; do not describe RLS as enforcing release restrictions.
- **View-as.** Admin "viewing as" a role gets that role in `session.role` AND in RLS (0182). Test with View-as.
- **Release-time DB gates (not bypassable):** `enforce_payment_before_release` (0133, INVOKER; reads `visits` under caller RLS — `visits: staff full` includes medtech/xray; never narrow it), `enforce_consent_before_release` (0088, DEFINER), GL bridge + package Leg A/B (0109). App mirrors: `moneySettled()` (`src/lib/visits/money-settled.ts`), `isConsentGateRequired()` / `getPatientConsentState()` (`src/lib/consent/gate.ts`). DB refusals are translated by `translatePgError` (`src/lib/accounting/pg-errors.ts:34-40`).
- **Combined reports.** One `results` row shared by several `test_requests` via `result_test_requests`. The portal serves the PDF only when EVERY linked test — deleted ones included — is `released` (`allLinksReleased`, `src/lib/results/release-eligibility.ts:32`). Finalisation sets each member to `result_uploaded` (needs sign-off) or `ready_for_release` independently (`0051:152`), so a report can be mixed. Undo already expands to the whole report (`expandUndoReleaseScope`, 0172).
- **Notifications.** `notifyResultReleased` / `notifyResultsReleasedBulk` (`src/lib/notifications/notify-released*.ts`): Physical/Pickup and sample visits send nothing (audit "skipped"); other media send the available SMS/email "your result is ready" notice. Doctor lines never notify.
- **Queue page.** `/staff/queue` (`queue/page.tsx`): reception force-redirected to `?filter=released_today`; `selectable = !receptionView && !releasedTab`; chemistry panels fold into `QueueCardGrouped` AFTER paging (a visible card may hold part of a panel); package headers excluded; `RealtimeRefresher` refreshes on any `test_requests` INSERT/UPDATE. Bulk kit: `src/lib/ui/bulk-selection.ts` (`MAX_BULK_ROWS=100`, `MAX_BULK_RECORDS=500`, entries carry `weight`), `src/components/staff/row-selection/*`, `src/lib/queue/bulk-queue.ts`, `queue/queue-bulk-bar.tsx`.
- **Bench page.** `/staff/queue/[id]`: chemistry services redirect to `/staff/queue/consolidated/[visitId]/[groupId]`; package components render here. Load query already has `visits.payment_status, hmo_provider_id`.
- **revalidatePath with a type** must name the route FILE path **including route groups** (`node_modules/next/dist/server/web/spec-extension/revalidate.js:80`, implicit tags from the file path). Concrete URLs without a type are fine for static routes.
- **Guards that will bite:**
  - `src/lib/visits/query-surfaces.test.ts`: every lab `test_requests` read needs a doctor-kind marker (`isDoctorKind(...)` or `DOCTOR_KINDS_PG_LIST`) in its own enclosing function, AND must exclude deleted rows (`deleted_at` pinned/selected) and pin the visit live (`visits.deleted_at`) or be a declared derived row set (see ~L1000-1035). Every new read below satisfies all three.
  - `staff-nav-config.test.ts` route-name guard: `<StatCard>` labels exempt; add no plain `{href,label}` literals to dashboard files.
  - `src/lib/dashboards/cards.test.ts` for new card ids.
- **Checks:** `npm test`, `npm run typecheck`, `npm run lint` before every TS commit; `npm run build` at the end. Local stack on OrbStack; **never `db reset`** the shared local DB.
- **Rollback:** reverting this code is safe (no schema). It does NOT undo releases or journal entries already produced (only Undo release reverses those), and nothing can recall a patient notification already sent or a copy the patient already viewed/downloaded — Undo sends no message.

## File map

| File | Change |
|---|---|
| `src/lib/visits/release-media.ts` (+test) | **New.** `ReleaseMedium`, `RELEASE_MEDIA`, `RELEASE_MEDIUM_OPTIONS`, `isReleaseMedium`. |
| `src/lib/visits/release-messages.ts` | **New.** Canonical refusal strings (shared with `pg-errors.ts`). |
| `src/lib/queue/release-eligibility.ts` (+test) | **New.** Pure `evaluateRelease`. |
| `src/lib/queue/report-release-scope.ts` (+test) | **New.** Pure `planReportRelease` (whole-report rules). |
| `src/lib/queue/bulk-queue.ts` (+test) | `QUEUE_KIND.release`, `releasable`, `memberIds` on `QueueRowInfo`, `BulkReleaseResult`, `bulkReleaseMessage`, `labelsByTestId`. |
| `src/lib/consent/gate.ts` (+`gate-batch.test.ts`) | `getConsentCurrentByPatient`. |
| `src/lib/actions/visits/release-rows.ts` (+test) | **New.** `releaseRows` core + `notifyReleased` (under `src/lib/actions/` so `write-guards.test.ts` keeps scanning the write). |
| `src/lib/visits/query-surfaces.test.ts` | Register the new read files in `SURFACES` ("lab") and `LIFECYCLES`. |
| `src/components/staff/release/release-outcome.tsx` (+test) | **New.** Page-level outcome notice that survives the control unmounting. |
| `visits/[id]/actions.ts` | Use release-media; `releaseSelectedAction` on `releaseRows`; `revalidateReleaseSurfaces`. |
| `src/lib/accounting/pg-errors.ts` | Import the two release strings (text unchanged). |
| `queue/actions.ts` + `queue/release-actions.test.ts` | **New** `releaseTestsAction`. |
| `src/components/staff/release/queue-release-button.tsx` (+test) | **New.** |
| `src/components/staff/release/undo-release-dialog.tsx` | **Moved** from `visits/[id]/`; `defaultOpen`. |
| `src/lib/visits/undo-scope.server.ts` (+test) | **New.** `loadRowUndoContext`. |
| `queue/[id]/page.tsx` | Release / Undo panels, copy fixes, `?undo=1`. |
| `queue/consolidated/[visitId]/[groupId]/page.tsx`, `report-cards.tsx` | Per-report Release / Undo; lifecycle selects. |
| `queue/page.tsx`, `queue/queue-bulk-bar.tsx` (+test) | Row + panel Release, panel checkboxes, bulk Release, Released-today Undo shortcut. |
| `src/lib/dashboards/cards.ts`, `_dashboards/lab-dashboard.tsx`, `_dashboards/reception-dashboard.tsx` | Cards/tiles. |
| `src/lib/staff/release-notifications.ts` (+test), `src/components/staff/notification-bell.tsx` | Reception bell alert. |
| `docs/drmed-user-guide.html`, `CLAUDE.md` pointer line | Docs. |

---

### Task 1: Shared release-medium module

**Files:** Create `src/lib/visits/release-media.ts`, `src/lib/visits/release-media.test.ts`; modify `visits/[id]/actions.ts:41-70`, `visits/[id]/release-button.tsx`, `visits/[id]/bulk-action-bar.tsx`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/visits/release-media.test.ts
import { describe, expect, it } from "vitest";
import { RELEASE_MEDIA, RELEASE_MEDIUM_OPTIONS, isReleaseMedium } from "./release-media";

describe("release media", () => {
  it("lists the six media the DB accepts, in dropdown order", () => {
    expect(RELEASE_MEDIA).toEqual(["physical", "email", "viber", "gcash", "pickup", "other"]);
    expect(RELEASE_MEDIUM_OPTIONS.map((o) => o.value)).toEqual([...RELEASE_MEDIA]);
    expect(RELEASE_MEDIUM_OPTIONS[0]).toEqual({ value: "physical", label: "Physical" });
  });
  it("narrows unknown input", () => {
    expect(isReleaseMedium("email")).toBe(true);
    expect(isReleaseMedium("fax")).toBe(false);
    expect(isReleaseMedium(null)).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/lib/visits/release-media.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement**

```ts
// src/lib/visits/release-media.ts
// How a released result reaches the patient. One list for every release
// control (visit page, bulk bars, lab queue) and the server-side validation.
export const RELEASE_MEDIA = ["physical", "email", "viber", "gcash", "pickup", "other"] as const;
export type ReleaseMedium = (typeof RELEASE_MEDIA)[number];

export const RELEASE_MEDIUM_OPTIONS: ReadonlyArray<{ value: ReleaseMedium; label: string }> = [
  { value: "physical", label: "Physical" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup" },
  { value: "other", label: "Other" },
];

export function isReleaseMedium(v: unknown): v is ReleaseMedium {
  return typeof v === "string" && (RELEASE_MEDIA as readonly string[]).includes(v);
}
```

- [ ] **Step 4:** In `visits/[id]/actions.ts` replace the local `ReleaseMedium` union and `VALID_MEDIA` with `import { RELEASE_MEDIA, type ReleaseMedium } from "@/lib/visits/release-media"; export type { ReleaseMedium }; const VALID_MEDIA: readonly ReleaseMedium[] = RELEASE_MEDIA;`. In `release-button.tsx` and `bulk-action-bar.tsx` delete the local option lists and import `RELEASE_MEDIUM_OPTIONS`.
- [ ] **Step 5:** test PASS; `npm run typecheck`. **Commit** `refactor(release): one shared release-medium list`.

---

### Task 2: Shared refusal strings + pure release eligibility

**Files:** Create `src/lib/visits/release-messages.ts`, `src/lib/queue/release-eligibility.ts`, `src/lib/queue/release-eligibility.test.ts`; modify `src/lib/accounting/pg-errors.ts:34-40`, `visits/[id]/release-button.tsx` (title strings).

- [ ] **Step 1: Messages module** (text of the two DB-backed strings is exactly today's `translatePgError` text, so existing tests stay green and a DB refusal reads the same as a disabled button):

```ts
// src/lib/visits/release-messages.ts
// One wording for "why can't this be released", whether the reason comes
// from the app (disabled button, skipped bulk row) or from the database
// trigger (translatePgError). Change a string here, not at a call site.
export const RELEASE_BLOCKED_UNPAID =
  "Visit must be paid, waived, or HMO-covered before results can be released.";
export const RELEASE_BLOCKED_CONSENT =
  "Patient data-privacy consent is not on file — capture consent before releasing.";
```

In `pg-errors.ts` replace the two literals in the `23514` branch with these constants (import). In `release-button.tsx` use them for the two `title` strings.

- [ ] **Step 2: Failing eligibility test**

```ts
// src/lib/queue/release-eligibility.test.ts
import { describe, expect, it } from "vitest";
import { evaluateRelease, RELEASE_REFUSAL, type ReleaseCandidate } from "./release-eligibility";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

const ok: ReleaseCandidate = {
  status: "ready_for_release", isPackageHeader: false, isDoctorLine: false, section: "microbiology",
  visitDeleted: false, patientActive: true, visit: { payment_status: "paid", hmo_provider_id: null },
  consentOnFile: true, gateRequired: false,
};

describe("evaluateRelease", () => {
  it("allows an in-section medtech on a paid visit", () => {
    expect(evaluateRelease(ok, "medtech")).toEqual({ ok: true });
  });
  it("denies reception outright", () => {
    expect(evaluateRelease(ok, "reception")).toEqual({ ok: false, error: RELEASE_REFUSAL.reception });
  });
  it("scopes by section", () => {
    const xray = { ...ok, section: "imaging_xray" };
    expect(evaluateRelease(xray, "medtech")).toEqual({ ok: false, error: RELEASE_REFUSAL.section });
    expect(evaluateRelease(xray, "xray_technician").ok).toBe(true);
    expect(evaluateRelease(xray, "pathologist").ok).toBe(true);
  });
  it("refuses anything not at ready_for_release", () => {
    expect(evaluateRelease({ ...ok, status: "released" }, "admin")).toEqual({ ok: false, error: RELEASE_REFUSAL.notReady });
    expect(evaluateRelease({ ...ok, status: "result_uploaded" }, "admin").ok).toBe(false);
  });
  it("refuses headers, doctor lines, deleted visits and inactive patients", () => {
    expect(evaluateRelease({ ...ok, isPackageHeader: true }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, isDoctorLine: true, section: null }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, visitDeleted: true }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, patientActive: false }, "admin").ok).toBe(false);
  });
  it("mirrors the payment gate: unpaid blocks; waived and HMO pass", () => {
    const unpaid = { ...ok, visit: { payment_status: "unpaid", hmo_provider_id: null } };
    expect(evaluateRelease(unpaid, "admin")).toEqual({ ok: false, error: RELEASE_BLOCKED_UNPAID });
    expect(evaluateRelease({ ...ok, visit: { payment_status: "waived", hmo_provider_id: null } }, "admin").ok).toBe(true);
    expect(evaluateRelease({ ...unpaid, visit: { payment_status: "unpaid", hmo_provider_id: "h1" } }, "admin").ok).toBe(true);
  });
  it("blocks missing consent only while the gate is on", () => {
    expect(evaluateRelease({ ...ok, consentOnFile: false }, "admin").ok).toBe(true);
    expect(evaluateRelease({ ...ok, consentOnFile: false, gateRequired: true }, "admin"))
      .toEqual({ ok: false, error: RELEASE_BLOCKED_CONSENT });
  });
});
```

- [ ] **Step 3:** run → FAIL.
- [ ] **Step 4: Implement**

```ts
// src/lib/queue/release-eligibility.ts
// Per-row release predicate for the lab queue — bench page, consolidated
// report, queue rows, bulk bar and releaseTestsAction all use it, so every
// surface refuses for the same reason in the same words. Pure: no I/O.
// The DB still enforces payment (0133) and consent (0088) at UPDATE time.
import type { StaffSession } from "@/lib/auth/require-staff";
import { canActOnResult } from "@/lib/visits/line-visibility";
import { moneySettled, type MoneySettledVisit } from "@/lib/visits/money-settled";
import type { Eligibility } from "@/lib/queue/claim-eligibility";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

type Role = StaffSession["role"];

export interface ReleaseCandidate {
  status: string;
  isPackageHeader: boolean;
  /** isDoctorKind(services.kind), computed next to the caller's read (query-surfaces guard). */
  isDoctorLine: boolean;
  section: string | null;
  visitDeleted: boolean;
  patientActive: boolean;
  visit: MoneySettledVisit;
  consentOnFile: boolean;
  gateRequired: boolean;
}

export const RELEASE_REFUSAL = {
  reception: "Results are released by the lab team, not reception.",
  notReady: "This result is no longer ready to release.",
  header: "Package headers release on their own once every test in the package is released.",
  doctor: "Consultations and procedures are completed on the visit page with “Mark done”.",
  visitDeleted: "This visit was deleted from the queue.",
  patientInactive: "This patient's record is no longer active — open the surviving record.",
  section: "This test is outside the sections you can release.",
  unpaid: RELEASE_BLOCKED_UNPAID,
  consent: RELEASE_BLOCKED_CONSENT,
} as const;

export function evaluateRelease(c: ReleaseCandidate, role: Role): Eligibility {
  if (role === "reception") return { ok: false, error: RELEASE_REFUSAL.reception };
  if (c.visitDeleted) return { ok: false, error: RELEASE_REFUSAL.visitDeleted };
  if (!c.patientActive) return { ok: false, error: RELEASE_REFUSAL.patientInactive };
  if (c.isPackageHeader) return { ok: false, error: RELEASE_REFUSAL.header };
  if (c.isDoctorLine) return { ok: false, error: RELEASE_REFUSAL.doctor };
  if (!canActOnResult(role, c.section)) return { ok: false, error: RELEASE_REFUSAL.section };
  if (c.status !== "ready_for_release") return { ok: false, error: RELEASE_REFUSAL.notReady };
  if (!moneySettled(c.visit)) return { ok: false, error: RELEASE_REFUSAL.unpaid };
  if (c.gateRequired && !c.consentOnFile) return { ok: false, error: RELEASE_REFUSAL.consent };
  return { ok: true };
}
```

(Export `MoneySettledVisit` from `money-settled.ts` if it isn't already.)

- [ ] **Step 5:** PASS; `npm test` (pg-errors tests unchanged) + typecheck. **Commit** `feat(queue): shared release refusal wording and pure eligibility`.

---

### Task 3: Queue kinds, panel member ids, release outcome message

**Files:** `src/lib/queue/bulk-queue.ts`, `src/lib/queue/bulk-queue.test.ts`

- [ ] **Step 1: Failing tests** (add; update existing `queueRowKinds` calls to pass `releasable: false`):

```ts
import { bulkReleaseMessage, labelsByTestId, QUEUE_KIND, queueRowKinds } from "./bulk-queue";

it("orders release after claim/unclaim and before delete", () => {
  expect(queueRowKinds({ claimable: false, unclaimable: false, releasable: true, deletable: true }))
    .toEqual([QUEUE_KIND.release, QUEUE_KIND.delete]);
});

it("maps every panel member to its card's label", () => {
  const rows = {
    t1: { visitId: "v", label: "FECALYSIS — Jamila, Ian", assignedTo: null },
    "panel:v:g": { visitId: "v", label: "Chemistry — Cruz, Ana", assignedTo: null, memberIds: ["a", "b"] },
  };
  expect(labelsByTestId(rows)).toEqual({
    t1: rows.t1,
    a: rows["panel:v:g"],
    b: rows["panel:v:g"],
  });
});

it("reports tests, and the extra report members a release pulled in", () => {
  const rows = { a: { visitId: "v", label: "FBS — Cruz, Ana", assignedTo: null } };
  expect(bulkReleaseMessage(1, { changedIds: ["a"], skipped: [], alsoReleasedIds: ["b", "c"] }, rows))
    .toBe("Released 1 test.\nAlso released 2 other tests on the same combined report.");
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**

```ts
export const QUEUE_KIND = {
  claim: "claimable",
  unclaim: "unclaimable",
  release: "releasable",
  delete: "deletable",
} as const;

export function queueRowKinds(flags: {
  claimable: boolean; unclaimable: boolean; releasable: boolean; deletable: boolean;
}): QueueKind[] {
  const kinds: QueueKind[] = [];
  if (flags.claimable) kinds.push(QUEUE_KIND.claim);
  if (flags.unclaimable) kinds.push(QUEUE_KIND.unclaim);
  if (flags.releasable) kinds.push(QUEUE_KIND.release);
  if (flags.deletable) kinds.push(QUEUE_KIND.delete);
  return kinds;
}

export interface QueueRowInfo {
  visitId: string;
  label: string;
  assignedTo: string | null;
  /** A chemistry panel card: the test ids it stands for (its rowKey is the card key). */
  memberIds?: string[];
}

/** Expand panel rows so an outcome message can name a skipped member test by its card. */
export function labelsByTestId(
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): Record<string, QueueRowInfo> {
  const out: Record<string, QueueRowInfo> = {};
  for (const [key, info] of Object.entries(rowsByKey)) {
    if (info.memberIds) for (const id of info.memberIds) out[id] = info;
    else out[key] = info;
  }
  return out;
}

export type BulkReleaseResult =
  | { ok: true; changedIds: string[]; skipped: SkippedRow[]; alsoReleasedIds: string[] }
  | { ok: false; error: string };

export function bulkReleaseMessage(
  sentCount: number,
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[]; alsoReleasedIds: readonly string[] },
  rowsByTestId: Readonly<Record<string, QueueRowInfo>>,
): string {
  const base = bulkQueueMessage("Released", sentCount, result, rowsByTestId);
  const n = result.alsoReleasedIds.length;
  return n === 0 ? base : `${base}\nAlso released ${n} other ${tests(n)} on the same combined report.`;
}
```

Update `queue/page.tsx` `singleKinds` to pass `releasable: false` (Task 13 sets it).
- [ ] **Step 4:** PASS + typecheck. **Commit** `feat(queue): releasable kind, panel member ids, release outcome message`.

---

### Task 4: Release/undo refresh every surface (route-group-correct)

**Files:** `visits/[id]/actions.ts`; create `visits/[id]/revalidate-release.test.ts`

- [ ] **Step 1: Failing test.** Mock like `view-as/actions.test.ts` (`server-only`, `next/cache` capturing `revalidatePath` args, `@/lib/auth/require-staff`, `@/lib/supabase/server` stub). Read `refuseIfVisitDeleted` + `assertVisitPatientActive` first and make the stub's first `.maybeSingle()` return a live visit with an active patient, the candidate read `{ data: null }`. Assert `releaseTestAction("t1","v1","physical")` (the "no longer ready" path) records exactly:

```ts
expect(fx.revalidated).toEqual([
  ["/staff/visits/v1"],
  ["/(staff)/staff/(dashboard)/queue", "layout"],
  ["/staff"],
]);
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**

```ts
// Every surface that shows a line's release state. A TYPED revalidatePath
// must name the route FILE path, route groups included — "/staff/queue" +
// "layout" matches no tag (next/…/revalidate.js). The layout revalidation
// covers /staff/queue, /staff/queue/[id] and the consolidated report page;
// "/staff" (untyped, a concrete URL) is the dashboard.
function revalidateReleaseSurfaces(visitId: string) {
  revalidatePath(`/staff/visits/${visitId}`);
  revalidatePath("/(staff)/staff/(dashboard)/queue", "layout");
  revalidatePath("/staff");
}
```

Replace every `revalidatePath(\`/staff/visits/${visitId}\`)` inside `releaseTestAction`, `releaseAllReadyComponentsAction`, `releasePackageHeaderAction`, `releaseSelectedAction`, `undoReleaseSelectedAction` and `undoReleasedRows` with `revalidateReleaseSurfaces(visitId)`. Leave other actions in the file alone; `grep -n 'revalidatePath(`/staff/visits' actions.ts` afterwards — every remaining hit must be outside those functions.
- [ ] **Step 4:** PASS; `npm test && npm run typecheck`. Runtime refresh is verified in Task 17 (each surface, second tab). **Commit** `fix(release): release and undo refresh the lab queue and dashboard`.

---

### Task 5: Batch consent read

**Files:** `src/lib/consent/gate.ts`; create `src/lib/consent/gate-batch.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const seen: { ids?: string[] } = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: (_c: string, ids: string[]) => {
          seen.ids = ids;
          return Promise.resolve({ data: [{ id: "p1", consent_current: true }, { id: "p2", consent_current: false }], error: null });
        },
      }),
    }),
  }),
}));
const { getConsentCurrentByPatient } = await import("./gate");

describe("getConsentCurrentByPatient", () => {
  it("maps each patient to consent_current, de-duplicating ids", async () => {
    const m = await getConsentCurrentByPatient(["p1", "p2", "p1"]);
    expect(seen.ids).toEqual(["p1", "p2"]);
    expect(m.get("p1")).toBe(true);
    expect(m.get("p2")).toBe(false);
  });
  it("skips the query for an empty list", async () => {
    seen.ids = undefined;
    expect((await getConsentCurrentByPatient([])).size).toBe(0);
    expect(seen.ids).toBeUndefined();
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement** (append to `gate.ts`):

```ts
/**
 * consent_current for many patients in one read (the lab queue lists up to
 * 100 rows across visits). Admin client, same as getPatientConsentState. A
 * missing patient reads as false. Display/preflight only — the DB trigger
 * (0088) is the guard at release time.
 */
export async function getConsentCurrentByPatient(
  patientIds: readonly string[],
): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(patientIds));
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const admin = createAdminClient();
  const { data } = await admin.from("patients").select("id, consent_current").in("id", ids);
  for (const r of data ?? []) out.set(r.id, !!r.consent_current);
  return out;
}
```

- [ ] **Step 4:** PASS. **Commit** `feat(consent): batch consent read for the lab queue`.

---

### Task 6: `releaseRows` core — authoritative released ids

**Files:** Create `src/lib/actions/visits/release-rows.ts`, `src/lib/actions/visits/release-rows.test.ts`; modify `visits/[id]/actions.ts` (`releaseSelectedAction`, ~L460-567).

Why: `releaseSelectedAction` already gets the exact released rows from `UPDATE … RETURNING` (~L502) but returns only a count. The queue needs the ids, and needs to decide notifications per combined report. Extract, don't duplicate.

- [ ] **Step 1: Failing test** (fake Supabase with an in-memory `test_requests`; mock `@/lib/audit/log`, `@/lib/notifications/notify-released`, `@/lib/notifications/notify-released-bulk`, `@/lib/observability/report-error`, `next/headers`):
  - releases only in-section `ready_for_release` non-header rows of the given visit; returns `releasedIds` equal to the RETURNING rows;
  - writes one `test_request.released` audit per released id with the passed `auditMeta` merged in;
  - `releaseRows` itself never notifies; `notifyReleased(visitId, rows, medium)` calls `notifyResultReleased` for one row and `notifyResultsReleasedBulk` for several, and a thrown notify is reported via `reportError`, not rethrown;
  - a DB error returns `{ ok:false, error: translatePgError(err) }` (e.g. 23514 consent → `RELEASE_BLOCKED_CONSENT`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement**

```ts
// src/lib/actions/visits/release-rows.ts
import "server-only";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffSession } from "@/lib/auth/require-staff";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { audit } from "@/lib/audit/log";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { notifyResultsReleasedBulk } from "@/lib/notifications/notify-released-bulk";
import { reportError } from "@/lib/observability/report-error";
import type { ReleaseMedium } from "@/lib/visits/release-media";

export type ReleasedRow = { id: string; name: string };

/**
 * The one release write (visit page bulk bar + lab queue). Section-scopes the
 * candidates (RLS is role-only), flips ready_for_release → released in ONE
 * statement, audits each row the statement actually returned, and returns
 * those rows — the authoritative write set. It does NOT notify: the caller
 * decides (the queue withholds the notice for a combined report that did not
 * end fully released). Payment/consent/GL/package triggers fire as usual.
 */
export async function releaseRows(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  ids: readonly string[];
  medium: ReleaseMedium;
  auditMeta?: Record<string, unknown>;
}): Promise<{ ok: true; released: ReleasedRow[] } | { ok: false; error: string }> {
  const { supabase, session, visitId, ids, medium } = args;
  // Lab read of test_requests: doctor lines never reach ready_for_release by
  // design, but the queue guard wants the marker here, not by inference.
  const { data: candidates, error: readErr } = await supabase
    .from("test_requests")
    .select(
      "id, deleted_at, services!inner ( section, name, kind ), visits!inner ( deleted_at, patients!inner ( deleted_at, merged_into_id ) )",
    )
    .in("id", [...ids])
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .eq("is_package_header", false)
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  // Self-guarding: every caller also checks, but the write must not depend on
  // that — a merged/deleted patient's lines are never released (write-guards).
  const live = (candidates ?? []).filter((r) => {
    const v = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    const p = v ? (Array.isArray(v.patients) ? v.patients[0] : v.patients) : null;
    return isActivePatient(p);
  });
  if (live.length !== (candidates ?? []).length) {
    return { ok: false, error: RELEASE_REFUSAL_PATIENT_INACTIVE };
  }
  const scoped = scopeToAllowedSections(live, sectionsForRole(session.role));
  if (scoped.length === 0) return { ok: true, released: [] };

  const { data: updated, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: new Date().toISOString(),
      released_by: session.user_id,
      release_medium: medium,
    })
    .in("id", scoped.map((r) => r.id))
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .select("id, services ( name )");
  if (error) return { ok: false, error: translatePgError(error) };

  const released: ReleasedRow[] = (updated ?? []).map((r) => {
    const s = Array.isArray(r.services) ? r.services[0] : r.services;
    return { id: r.id, name: s?.name ?? "Result" };
  });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  for (const row of released) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.released",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: visitId, release_medium: medium, bulk: true, selection: true, ...args.auditMeta },
      ip_address: ip,
      user_agent: ua,
    });
  }
  return { ok: true, released };
}

/** The patient "result ready" notice for rows a caller decided to announce. Never throws. */
export async function notifyReleased(visitId: string, rows: readonly ReleasedRow[], medium: ReleaseMedium) {
  if (rows.length === 0) return;
  try {
    if (rows.length === 1) {
      await notifyResultReleased({ testRequestId: rows[0].id, visitId, releaseMedium: medium });
    } else {
      await notifyResultsReleasedBulk({
        visitId,
        testRequestIds: rows.map((r) => r.id),
        testNames: rows.map((r) => r.name),
        releaseMedium: medium,
      });
    }
  } catch (err) {
    await reportError({
      scope: "notify/result-released-selection",
      error: err,
      metadata: { visit_id: visitId, test_request_ids: rows.map((r) => r.id) },
    });
  }
}
```

(Import `DOCTOR_KINDS_PG_LIST` from `@/lib/visits/classification`, `isActivePatient` from `@/lib/patients/active`; add `RELEASE_REFUSAL_PATIENT_INACTIVE = "This patient's record is no longer active — open the surviving record."` to `release-messages.ts` and point `RELEASE_REFUSAL.patientInactive` at it. Match `audit`'s real field names by reading `src/lib/audit/log.ts` before writing.)

**Guard registration (same commit):** the file lives in `src/lib/actions/visits/` so `src/lib/patients/write-guards.test.ts` (which scans `src/lib/actions/**`, `src/lib/results/**` and `"use server"` files, ~L187) keeps covering the release write now that it left the action body — read that test's accepted-guard rule and make sure the in-function `isActivePatient` check above satisfies it (add the file to its allow/owner list only if the test requires an explicit entry, with a justification). In `src/lib/visits/query-surfaces.test.ts` add `"src/lib/actions/visits/release-rows.ts"` to `SURFACES` as `"lab"` and to `LIFECYCLES` as live (see ~L1064 and ~L1184 for the shape). Run `npx vitest run src/lib/visits/query-surfaces.test.ts src/lib/patients/write-guards.test.ts` → green.

- [ ] **Step 4: Rewire `releaseSelectedAction`** — keep its signature, medium/empty/limit checks, `requireActiveStaff`, `refuseIfVisitDeleted`; replace its read → update → audit → notify body with:

```ts
const res = await releaseRows({ supabase, session, visitId, ids: testRequestIds, medium: releaseMedium });
if (!res.ok) return { ok: false, error: res.error };
if (res.released.length === 0) {
  revalidateReleaseSurfaces(visitId);
  return { ok: false, error: "None of the selected tests are ready to release." };
}
await notifyReleased(visitId, res.released, releaseMedium);
revalidateReleaseSurfaces(visitId);
return { ok: true, count: res.released.length };
```

Add a pin test for `releaseSelectedAction` (mock `@/lib/actions/visits/release-rows`): released rows → notify called with them, `{ok:true,count}`; empty → the existing error string; error → passthrough.
- [ ] **Step 5:** `npm test && npm run typecheck && npm run lint` (query-surfaces guard green). **Commit** `refactor(release): one release write that returns the rows it released`.

---

### Task 7: Pure whole-report planner

**Files:** Create `src/lib/queue/report-release-scope.ts`, `src/lib/queue/report-release-scope.test.ts`

Rules (per touched combined report = a result with >1 linked test):
1. Structural rejections reuse `expandUndoReleaseScope` (outside sections / package header / other visit), run over the full membership.
2. Any member that is **deleted and not released** → reject: the portal counts deleted members and would never serve the PDF.
3. Any live member not in `{ready_for_release, released}` (e.g. `result_uploaded` awaiting sign-off, `in_progress`) → reject "not finished".
4. Any doctor-kind member → reject as a header-like anomaly.
5. Otherwise the report's release set = every live member at `ready_for_release`. Rejection removes only that report's members from the selection; other reports and plain rows continue.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { planReportRelease, REPORT_REFUSAL, type ReportMember } from "./report-release-scope";

const m = (id: string, over: Partial<ReportMember> = {}): ReportMember => ({
  testRequestId: id, resultId: "r1", visitId: "v1", isPackageHeader: false, section: "chemistry",
  status: "ready_for_release", deleted: false, isDoctorLine: false, ...over,
});

describe("planReportRelease", () => {
  it("passes a plain row with no shared report through", () => {
    expect(planReportRelease({ selectedIds: ["x"], members: [], visitId: "v1", allowedSections: ["chemistry"] }))
      .toEqual({ releaseIds: ["x"], alsoIds: [], rejected: [], reportOf: {} });
  });
  it("pulls in every ready member of a touched report", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b"), m("c", { status: "released" })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.releaseIds.sort()).toEqual(["a", "b"]);
    expect(r.alsoIds).toEqual(["b"]);
    expect(r.reportOf).toEqual({ a: "r1", b: "r1", c: "r1" });
  });
  it("refuses a mixed report with a member awaiting sign-off", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b", { status: "result_uploaded" })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.releaseIds).toEqual([]);
    expect(r.rejected).toEqual([{ resultId: "r1", selectedIds: ["a"], reason: REPORT_REFUSAL.notFinished(1) }]);
  });
  it("refuses a report with a deleted, unreleased member", () => {
    const r = planReportRelease({ selectedIds: ["a"], members: [m("a"), m("b", { deleted: true })], visitId: "v1", allowedSections: ["chemistry"] });
    expect(r.rejected[0].reason).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("refuses a report reaching outside the caller's sections, keeping other rows", () => {
    const r = planReportRelease({
      selectedIds: ["a", "x"],
      members: [m("a"), m("b", { section: "imaging_xray" })],
      visitId: "v1", allowedSections: ["chemistry"],
    });
    expect(r.releaseIds).toEqual(["x"]);
    expect(r.rejected[0].reason).toBe(REPORT_REFUSAL.outside_sections);
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement**

```ts
// src/lib/queue/report-release-scope.ts
// Whole-report release for the lab queue. The portal serves a combined
// report's PDF only when every linked test — deleted ones included — is
// released (allLinksReleased), so the queue releases a combined report whole
// or not at all. Structural checks reuse the undo expansion (0172); the
// status/deletion rules are release-specific. Pure.
import { expandUndoReleaseScope, type UndoScopeMemberRow, type UndoScopeRejectionReason } from "@/lib/visits/undo-release-scope";

export interface ReportMember extends UndoScopeMemberRow {
  status: string;
  deleted: boolean;
  isDoctorLine: boolean;
}

export const REPORT_REFUSAL = {
  outside_sections: "This combined report has tests outside the sections you can release — ask an admin.",
  package_header: "This combined report includes a package header, which shouldn't happen — ask an admin to check it.",
  other_visit: "This combined report spans more than one visit, which shouldn't happen — ask an admin to check it.",
  deletedMember: "A deleted test is still on this combined report, so the patient could never open it — ask an admin.",
  doctorMember: "A consultation is linked to this combined report, which shouldn't happen — ask an admin to check it.",
  notFinished: (n: number) =>
    `Part of this combined report isn't finished — ${n} test${n === 1 ? " is" : "s are"} still awaiting a result or sign-off.`,
} satisfies Record<UndoScopeRejectionReason, string> & Record<string, unknown>;

export interface ReportReleasePlan {
  /** Ids to send to the release write: survivors + pulled-in report members. */
  releaseIds: string[];
  /** Pulled-in members the operator did not select. */
  alsoIds: string[];
  rejected: { resultId: string; selectedIds: string[]; reason: string }[];
  /** testRequestId → resultId for every member of a touched combined report. */
  reportOf: Record<string, string>;
}

export function planReportRelease(input: {
  selectedIds: readonly string[];
  members: readonly ReportMember[];
  visitId: string;
  allowedSections: readonly string[] | null;
}): ReportReleasePlan {
  const byResult = new Map<string, ReportMember[]>();
  for (const mem of input.members) byResult.set(mem.resultId, [...(byResult.get(mem.resultId) ?? []), mem]);
  const reportOf: Record<string, string> = {};
  for (const [rid, mems] of byResult) if (mems.length > 1) for (const mem of mems) reportOf[mem.testRequestId] = rid;

  const selected = new Set(input.selectedIds);
  const rejected: ReportReleasePlan["rejected"] = [];
  const refused = new Set<string>();
  const pulled = new Set<string>();

  for (const [rid, mems] of byResult) {
    if (mems.length <= 1) continue;
    const mine = mems.filter((x) => selected.has(x.testRequestId)).map((x) => x.testRequestId);
    if (mine.length === 0) continue;
    let reason: string | null = null;
    const structural = expandUndoReleaseScope({
      selectedIds: mine, members: mems, visitId: input.visitId, allowedSections: input.allowedSections,
    });
    if (!structural.ok) reason = REPORT_REFUSAL[structural.reason];
    else if (mems.some((x) => x.isDoctorLine)) reason = REPORT_REFUSAL.doctorMember;
    else if (mems.some((x) => x.deleted && x.status !== "released")) reason = REPORT_REFUSAL.deletedMember;
    else {
      const unfinished = mems.filter((x) => !x.deleted && x.status !== "ready_for_release" && x.status !== "released");
      if (unfinished.length > 0) reason = REPORT_REFUSAL.notFinished(unfinished.length);
    }
    if (reason) {
      rejected.push({ resultId: rid, selectedIds: mine, reason });
      for (const x of mems) refused.add(x.testRequestId);
      continue;
    }
    for (const x of mems) if (!x.deleted && x.status === "ready_for_release") pulled.add(x.testRequestId);
  }

  const releaseIds = Array.from(new Set([
    ...input.selectedIds.filter((id) => !refused.has(id)),
    ...pulled,
  ]));
  return { releaseIds, alsoIds: releaseIds.filter((id) => !selected.has(id)), rejected, reportOf };
}
```

- [ ] **Step 4:** PASS + typecheck. **Commit** `feat(queue): whole-report release planner`.

---

### Task 8: `releaseTestsAction`

**Files:** `queue/actions.ts`; create `queue/release-actions.test.ts`

Contract (each pinned by a test):
1. `requireActiveStaff`; role not in `LAB_CAPABLE_ROLES` → `{ok:false, error: RELEASE_REFUSAL.reception}`, no reads (forged reception call).
2. zod `{ testRequestIds: uuid[] 1..MAX_BULK_RECORDS, medium: enum(RELEASE_MEDIA) }` → else `BULK_INPUT_ERROR`. After planning, if total `releaseIds` > `MAX_BULK_RECORDS` → `{ok:false, error:"Too many tests once whole reports are included — select fewer."}`.
3. One selected-rows read (signed-in client, `deleted_at` + `visits.deleted_at` pinned, `services.kind` selected for `isDoctorKind`), `isConsentGateRequired()`, `getConsentCurrentByPatient()`; `evaluateRelease` per row → `skipped` with its exact message; missing → "Deleted from the queue or no longer exists."
4. Survivors grouped by visit. Per visit: links read `result_test_requests.in(test_request_id, survivors)`; full membership read `result_test_requests.in(result_id, touched)` with `test_requests!inner ( id, visit_id, status, deleted_at, is_package_header, services!inner ( section, kind ) )` (it deliberately includes deleted members, exactly like the undo read; `query-surfaces.test.ts` scans only `.from("visits")`/`.from("test_requests")` chains, so this `result_test_requests` read needs NO registry entry — do not add a `DERIVED_ROW_SETS` exemption, it would be stale). `planReportRelease` → rejected reports' selected ids skipped with the reason.
   **Fail closed (pre-write).** If either read errors, skip every survivor of that visit with `"Couldn't check which report these tests belong to — try again."` and do NOT write. If a touched `result_id` comes back with fewer members than the links read showed for it (truncated/partial), treat it the same for that report's selected ids. Never interpret a failed or empty membership read as "no combined report".
5. Pulled-in members must also pass `evaluateRelease` at the visit level (same visit ⇒ same payment/consent/patient) — they do by construction; skip the call.
6. `releaseRows({ …, auditMeta: { source: "queue" } })`. Error → every selected id of that visit skipped with it (DB consent/payment text = `RELEASE_REFUSAL` text by Task 2).
7. **Completeness + notify.** Re-read statuses of every member of every touched report on that visit (same membership read, deleted included). For each touched report: complete iff the re-read returned **every member id the pre-write plan knew for that report (non-empty, none missing)** AND every one is `released`. If the post-write read errors or is missing members: keep the authoritative `changedIds` (the write happened), send NO notice for that report's rows, and add warning `"Released, but couldn't confirm the whole report went out — the patient was not notified. Check the report page."`. This check observes completeness at that moment; it cannot rule out an Undo landing between the check and delivery (documented, not claimed). Notify (`notifyReleased`) for released rows that are either not on a combined report or on a complete one. For an incomplete report (a concurrent change between plan and write): no notice for its rows, and its selected ids that were released stay in `changedIds` but a skipped-style note is added to the outcome: push `{ id: <first selected id of that report>, reason: "This combined report changed while releasing — some tests were released, the rest were not; the patient was not notified. Finish it from the report's page." }` **only if that id is not already in changedIds**; otherwise attach the note as `warnings: string[]` on the result (extend `BulkReleaseResult` ok-branch with `warnings: string[]`, shown by the bar/button). Residual race is documented; the portal fails closed on a partial report.
8. `changedIds` = selected ids in `released` (authoritative RETURNING); `alsoReleasedIds` = pulled-in ids in `released`; every selected id not changed and not yet skipped → "Released by someone else or changed just now." Assert selected ids partition exactly into changed/skipped.
9. `revalidatePath("/(staff)/staff/(dashboard)/queue", "layout")` and `revalidatePath("/staff")` once, plus `/staff/visits/${visitId}` per visit touched.

- [ ] **Step 1: Failing tests** (mock `server-only`, `next/cache`, `@/lib/auth/require-staff` with hoisted role, `@/lib/consent/gate`, `@/lib/actions/visits/release-rows` (`releaseRows` flips rows in a fake DB and returns them; `notifyReleased` records calls), `@/lib/supabase/server` fake client over in-memory `test_requests` + `result_test_requests`). Cases: forged reception; two visits both paid → one `releaseRows` per visit, both changed; unpaid row skipped with `RELEASE_BLOCKED_UNPAID`; waived + HMO rows released; deleted visit / inactive patient skipped; consent gate on + no consent skipped; `releaseRows` returns the consent DB error → that visit's ids skipped with `RELEASE_BLOCKED_CONSENT`; chemistry member with an unselected ready sibling → both released, sibling in `alsoReleasedIds`, `notifyReleased` got both; mixed report (sibling `result_uploaded`) → refused with `notFinished(1)`, `releaseRows` not called for it; deleted unreleased sibling → refused; race (fake `releaseRows` releases only one of two report members) → no notify for that report + warning; >500 after expansion → refusal; partition invariant. **Fail-closed cases:** links read errors → visit skipped, `releaseRows` not called; membership read errors → same; membership read returns fewer members than links → that report skipped; post-write read errors → changed ids kept, no notify, verification warning; post-write read missing a member → same. **Concurrency cases:** two same-user calls over overlapping ids (fake DB lets the first win) → each id appears in exactly one call's `changedIds`; a member flips to `result_uploaded` (sign-off) between the selected-rows read and the membership read → report refused as not finished.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** following the contract (≈150 lines; mirror `claimTestsAction`'s structure at `queue/actions.ts:268`). Map membership rows to `ReportMember` with `isDoctorLine: isDoctorKind(svc.kind)`, `deleted: tr.deleted_at !== null`.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint`. **Commit** `feat(queue): releaseTestsAction — lab releases from the queue, whole combined reports only`.

---

### Task 9a: Page-level release outcome notice

**Files:** Create `src/components/staff/release/release-outcome.tsx`, `release-outcome.test.tsx`.

Why: a successful release refreshes the page, which removes the pending row (or swaps Release for Undo on the report page) — any message held inside `QueueReleaseButton` unmounts with it, so a partial-release warning or "patient was not notified" note would vanish. The notice lives in a provider mounted ABOVE the controls (the page's top-level client wrapper), which `router.refresh()` does not remount.

```tsx
"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import type { BulkReleaseResult } from "@/lib/queue/bulk-queue";

type Ctx = { show: (text: string) => void };
const ReleaseOutcomeContext = createContext<Ctx | null>(null);

/** Builds the one message for a release outcome (tests pinned). */
export function releaseOutcomeText(res: Extract<BulkReleaseResult, { ok: true }>): string | null {
  const lines: string[] = [];
  if (res.changedIds.length > 0) lines.push(`Released ${res.changedIds.length} test${res.changedIds.length === 1 ? "" : "s"}.`);
  if (res.alsoReleasedIds.length > 0) lines.push(`Also released ${res.alsoReleasedIds.length} other test${res.alsoReleasedIds.length === 1 ? "" : "s"} on the same combined report.`);
  for (const s of res.skipped) lines.push(s.reason);
  lines.push(...res.warnings);
  return lines.length ? Array.from(new Set(lines)).join("\n") : null;
}

export function ReleaseOutcomeProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const show = useCallback((t: string) => setText(t), []);
  return (
    <ReleaseOutcomeContext.Provider value={{ show }}>
      {text ? (
        <Panel role="status" className="mb-4 flex items-start gap-3 p-3 text-xs">
          <p className="flex-1 whitespace-pre-line text-[color:var(--color-brand-text-mid)]">{text}</p>
          <button type="button" onClick={() => setText(null)} className="min-h-[44px] rounded-md border px-3 font-semibold">Dismiss</button>
        </Panel>
      ) : null}
      {children}
    </ReleaseOutcomeContext.Provider>
  );
}

/** Falls back to null outside a provider — the caller then shows the text inline. */
export function useReleaseOutcome(): Ctx | null {
  return useContext(ReleaseOutcomeContext);
}
```

- [ ] **Test** (jsdom): render provider + a child button that calls `show("Released 1 test.\nThe patient was not notified.")`, then `rerender` WITHOUT the child → the notice is still there; Dismiss removes it. Pure test of `releaseOutcomeText` for released / also-released / skipped / warnings / nothing.
- [ ] Mount `<ReleaseOutcomeProvider>` around the main content of `queue/page.tsx`, `queue/[id]/page.tsx` and the consolidated page (inside the server page, wrapping the section that holds the controls — it is a client component with server children, which is allowed).
- [ ] **Commit** `feat(release): release outcome notice that survives the refresh`.

---

### Task 9: `QueueReleaseButton` + move `UndoReleaseDialog`

> rev 3: `QueueReleaseButton` reports every outcome through `useReleaseOutcome()?.show(releaseOutcomeText(res))` (inline `role="status"` only as the no-provider fallback and for `{ok:false}` input errors). Adjust the component and its third test accordingly: assert the provider's notice shows the refusal and "Also released…" text after the button is unmounted.

**Files:** Create `src/components/staff/release/queue-release-button.tsx` (+ `.test.tsx`); `git mv visits/[id]/undo-release-dialog.tsx src/components/staff/release/undo-release-dialog.tsx`, change its import to `@/app/(staff)/staff/(dashboard)/visits/[id]/actions` (precedent: `src/components/staff/view-as-select.tsx`), add `defaultOpen?: boolean` → `useState(defaultOpen ?? false)`; update the visit page import.

- [ ] **Step 1: Failing DOM test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: unknown[] = [];
let reply: unknown = { ok: true, changedIds: ["t1"], skipped: [], alsoReleasedIds: [], warnings: [] };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(staff)/staff/(dashboard)/queue/actions", () => ({
  releaseTestsAction: async (input: unknown) => { calls.push(input); return reply; },
}));
const { QueueReleaseButton } = await import("./queue-release-button");

describe("QueueReleaseButton", () => {
  it("is disabled and explains why when blocked", () => {
    render(<QueueReleaseButton testRequestIds={["t1"]} preferredMedium={null} blockReason="Visit must be paid, waived, or HMO-covered before results can be released." />);
    expect(screen.getByRole("button", { name: "Release" })).toBeDisabled();
    expect(screen.getByText(/Visit must be paid/)).toBeInTheDocument();
  });
  it("sends the ids and the patient's preferred medium", async () => {
    render(<QueueReleaseButton testRequestIds={["t1", "t2"]} preferredMedium="email" blockReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(calls).toEqual([{ testRequestIds: ["t1", "t2"], medium: "email" }]));
  });
  it("shows a server refusal inline", async () => {
    reply = { ok: true, changedIds: [], skipped: [{ id: "t1", reason: "Part of this combined report isn't finished — 1 test is still awaiting a result or sign-off." }], alsoReleasedIds: [], warnings: [] };
    render(<QueueReleaseButton testRequestIds={["t1"]} preferredMedium={null} blockReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("status")).toHaveTextContent("isn't finished");
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { releaseTestsAction } from "@/app/(staff)/staff/(dashboard)/queue/actions";
import { RELEASE_MEDIUM_OPTIONS, type ReleaseMedium } from "@/lib/visits/release-media";

// The lab queue's Release control. Bench page, consolidated report, queue row
// and panel card differ only in the ids they send; releaseTestsAction
// re-proves every row and releases a combined report whole or not at all.
export function QueueReleaseButton({
  testRequestIds, preferredMedium, blockReason, consentWarning = false, label = "Release", size = "default",
}: {
  testRequestIds: string[];
  preferredMedium: ReleaseMedium | null;
  /** evaluateRelease's refusal, or null when it can be released. */
  blockReason: string | null;
  /** Consent missing while the gate is off — a warning, not a block. */
  consentWarning?: boolean;
  label?: string;
  size?: "default" | "compact";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [medium, setMedium] = useState<ReleaseMedium>(preferredMedium ?? "physical");
  const [message, setMessage] = useState<string | null>(null);
  const disabled = pending || blockReason !== null;
  const textCls = size === "compact" ? "text-[10px]" : "text-xs";

  function release() {
    start(async () => {
      setMessage(null);
      const res = await releaseTestsAction({ testRequestIds, medium });
      if (!res.ok) { setMessage(res.error); return; }
      const notes = [...res.skipped.map((s) => s.reason), ...res.warnings];
      if (notes.length > 0) setMessage(Array.from(new Set(notes)).join(" "));
      if (res.changedIds.length > 0) router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1.5">
        {consentWarning ? <span className="text-[11px] text-amber-600">Consent not on file</span> : null}
        <select
          value={medium}
          onChange={(e) => setMedium(e.target.value as ReleaseMedium)}
          disabled={disabled}
          aria-label="Release medium"
          className={`rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50 ${textCls}`}
        >
          {RELEASE_MEDIUM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button type="button" size="sm" disabled={disabled} title={blockReason ?? undefined}
          className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
          onClick={release}>
          {pending ? "Releasing…" : label}
        </Button>
      </div>
      {blockReason ? <span className={`${textCls} max-w-[18rem] text-right text-[color:var(--color-brand-text-soft)]`}>{blockReason}</span> : null}
      {message ? <span role="status" className={`${textCls} max-w-[18rem] text-right text-amber-700`}>{message}</span> : null}
    </div>
  );
}
```

- [ ] **Step 4:** PASS + typecheck + lint. **Commit** `feat(release): QueueReleaseButton; UndoReleaseDialog moves to shared components`.

---

### Task 10: Undo context for one row

**Files:** Create `src/lib/visits/undo-scope.server.ts` (+ test with a fake client and mocked `countResultViews`: single-link row → `reportScope:null`; 3-member report → 3 ids, label from report group, viewedCount summed).

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countResultViews } from "@/lib/results/viewed-count";
import type { ReportUndoScope } from "@/components/staff/release/undo-release-dialog";

/**
 * UndoReleaseDialog's inputs for ONE row outside the visit page: the
 * combined-report scope and the patient's view count over the report (the
 * visit page computes the same in bulk, visits/[id]/page.tsx ~L338-380,
 * ~L616-640). Display only — undoReleaseSelectedAction re-derives the scope.
 */
export async function loadRowUndoContext(
  supabase: SupabaseClient,
  testRequestId: string,
): Promise<{ reportScope: ReportUndoScope | null; viewedCount: number }> {
  const { data: links } = await supabase
    .from("result_test_requests").select("result_id").eq("test_request_id", testRequestId);
  const resultIds = Array.from(new Set((links ?? []).map((l) => l.result_id)));
  let memberIds = [testRequestId];
  let label = "combined";
  if (resultIds.length > 0) {
    const { data: members } = await supabase
      .from("result_test_requests")
      .select("test_request_id, test_requests!inner ( services!inner ( report_groups ( name ) ) )")
      .in("result_id", resultIds);
    const ids = Array.from(new Set((members ?? []).map((x) => x.test_request_id as string)));
    if (ids.length > 1) {
      memberIds = ids;
      const first = members?.[0] as unknown as {
        test_requests: { services: { report_groups: { name: string } | { name: string }[] | null } };
      };
      const rg = first?.test_requests?.services?.report_groups;
      label = (Array.isArray(rg) ? rg[0]?.name : rg?.name) ?? "combined";
    }
  }
  const counts = await Promise.all(memberIds.map((id) => countResultViews(id)));
  return { reportScope: memberIds.length > 1 ? { memberIds, label } : null, viewedCount: counts.reduce((a, b) => a + b, 0) };
}
```

- [ ] failing test → implement → PASS → **Commit** `feat(release): per-row undo context loader`.

---

### Task 11: Bench page — Release, Undo, copy

**Files:** `queue/[id]/page.tsx`

- [ ] **Step 1: Data.** Add `preferred_release_medium` to the `patients!inner ( … )` select. After `patientActive`:

```ts
const mayActOnResult = canActOnResult(session.role, svc.section);
const releaseMode = mayActOnResult && (test.status === "ready_for_release" || test.status === "released");
const [gateRequired, consentState] = releaseMode
  ? await Promise.all([isConsentGateRequired(), getPatientConsentState(patient.id)])
  : [false, { current: true }];
const releaseVerdict = evaluateRelease(
  {
    status: test.status, isPackageHeader: test.is_package_header, isDoctorLine: isDoctorKind(svc.kind),
    section: svc.section, visitDeleted: visit.deleted_at !== null, patientActive, visit,
    consentOnFile: consentState.current, gateRequired,
  },
  session.role,
);
const undoContext =
  test.status === "released" && mayActOnResult && patientActive && visit.deleted_at === null
    ? await loadRowUndoContext(supabase, test.id)
    : null;
const openUndo = (await searchParams)?.undo === "1";
```

Add `searchParams: Promise<{ undo?: string }>` to the page props if absent.
- [ ] **Step 2: Render** after "Result on file", before "No actions available…":

```tsx
{test.status === "ready_for_release" && mayActOnResult ? (
  <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
    <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">Release to patient</h2>
    <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
      Releasing puts the result in the patient&apos;s portal. For Email, Viber, GCash or Other the patient also gets a
      “your result is ready” text/email; Physical and Pickup send nothing.
    </p>
    {test.parent_id ? (
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Part of a package — each test releases on its own; the package closes itself once every test is released.
      </p>
    ) : null}
    <div className="mt-3">
      <QueueReleaseButton
        testRequestIds={[test.id]}
        preferredMedium={(patient.preferred_release_medium ?? null) as ReleaseMedium | null}
        blockReason={releaseVerdict.ok ? null : releaseVerdict.error}
        consentWarning={!consentState.current && !gateRequired}
      />
    </div>
  </div>
) : null}
{undoContext ? (
  <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
    <p className="text-sm text-[color:var(--color-brand-text-mid)]">Released. Made a mistake? Undo puts it back to ready for release.</p>
    <UndoReleaseDialog testRequestId={test.id} visitId={visit.id} viewedCount={undoContext.viewedCount}
      reportScope={undoContext.reportScope} defaultOpen={openUndo} />
  </div>
) : null}
```

Update the "No actions available" condition to exclude both panels.
- [ ] **Step 3: Copy** (~L529, ~L556): `reception can release it once the visit is paid` → `release it here once the visit is paid`.
- [ ] **Step 4:** typecheck + lint + test. **Commit** `feat(queue): release and undo on the lab bench page`.

---

### Task 12: Consolidated report page — Release / Undo per report

**Files:** `queue/consolidated/[visitId]/[groupId]/page.tsx`, `report-cards.tsx`

- [ ] **Step 1: Selects + types.** In `loadConsolidatedDetail`'s `test_requests` read (~L82) change the embeds to `services!inner(id, code, name, section, kind, report_group_id)` and `patients!inner(drm_id, last_name, first_name, sex, birthdate, deleted_at, merged_into_id, preferred_release_medium)`; keep `.is("visits.deleted_at", null)` (so `visitDeleted` is false on this page by construction — pass `false` and say so in a comment). Extend `ConsolidatedFormVisit` (~L595): `payment_status: string; hmo_provider_id: string | null;` and `patients.deleted_at: string | null; merged_into_id: string | null; preferred_release_medium: string | null`. Derive `const patientActive = isActivePatient(visit.patients);`. Doctor-kind marker: `kind` is now selected; add `isDoctorKind` use in this function (members filter) so the query-surfaces guard sees it.
- [ ] **Step 2: Per-report actions** (server side, before render):

```ts
const lab = canActOnResult(session.role, groupSection); // section of the group's services (all members share it)
const [gateRequired, consentState] = lab
  ? await Promise.all([isConsentGateRequired(), getPatientConsentState(visit.patient_id)])
  : [false, { current: true }];
const actionsFor: Record<string, ReactNode> = {};
for (const rep of reports) {
  if (!lab || !patientActive) continue;
  const ready = rep.members.filter((x) => x.status === "ready_for_release").map((x) => x.id);
  if (ready.length > 0) {
    const v = evaluateRelease({ status: "ready_for_release", isPackageHeader: false, isDoctorLine: false,
      section: groupSection, visitDeleted: false, patientActive, visit,
      consentOnFile: consentState.current, gateRequired }, session.role);
    actionsFor[rep.resultId] = (
      <QueueReleaseButton testRequestIds={ready} label="Release report"
        preferredMedium={(visit.patients.preferred_release_medium ?? null) as ReleaseMedium | null}
        blockReason={v.ok ? null : v.error} consentWarning={!consentState.current && !gateRequired} />
    );
  } else if (rep.members.some((x) => x.status === "released")) {
    const ctx = await loadRowUndoContext(supabase, rep.pdfTestRequestId);
    actionsFor[rep.resultId] = (
      <UndoReleaseDialog testRequestId={rep.pdfTestRequestId} visitId={visit.id}
        viewedCount={ctx.viewedCount} reportScope={ctx.reportScope} />
    );
  }
}
```

(A mixed report still shows "Release report"; the server refuses it with the "isn't finished" message, shown inline.)
- [ ] **Step 3:** `ReportCards` gets `actionsFor?: Record<string, ReactNode>`, rendered in each card's header row, right side. Pass it.
- [ ] **Step 4: Test.** Unit-test a small pure helper if you extract one (`reportActionKind(members) → "release" | "undo" | null`); otherwise cover in Task 17 (incl. inactive patient: no Release/Undo).
- [ ] **Step 5:** typecheck + lint + test. **Commit** `feat(queue): release and undo whole chemistry reports from their page`.

---

### Task 13: Queue list — rows, panels, bulk, Released-today Undo

**Files:** `queue/page.tsx`, `queue/queue-bulk-bar.tsx`, create `queue/queue-bulk-bar.test.tsx`

- [ ] **Step 1: Query.** List select embeds become `services!inner ( id, code, name, kind, turnaround_hours, section, report_group_id, report_groups ( code, name ) )` (unchanged) and `visits!inner ( id, visit_number, payment_status, hmo_provider_id, is_sample, patients!inner ( id, drm_id, first_name, last_name, preferred_release_medium, deleted_at, merged_into_id ) )`. When `filter === "pending_release" && !receptionView`: `const [gateRequired, consentByPatient] = await Promise.all([isConsentGateRequired(), getConsentCurrentByPatient(patientIds)])`.
- [ ] **Step 2: Card fields** on both card types: `releaseBlock: string | null`, `preferredMedium: ReleaseMedium | null`, `consentWarning: boolean`, and on grouped `section: string | null` (first member's). Single: `evaluateRelease` on the row (`visitDeleted:false` — the list pins `visits.deleted_at`; `patientActive: isActivePatient(patient)`). Grouped: evaluate each member; `releaseBlock` = first refusal or null. Off the pending tab: `releaseBlock = RELEASE_REFUSAL.notReady`, no consent read.
- [ ] **Step 3: Action cells.** Single, before the existing chain:

```tsx
{filter === "pending_release" && !receptionView ? (
  <QueueReleaseButton testRequestIds={[card.testRequestId]} preferredMedium={card.preferredMedium}
    blockReason={card.releaseBlock} consentWarning={card.consentWarning} size="compact" />
) : null}
```

Grouped: same with `testRequestIds={card.memberIds}` and `label="Release panel"` (server expands a page-split panel to the whole report).
- [ ] **Step 4: Selection.** Single: `releasable: filter === "pending_release" && card.releaseBlock === null`. **Panels (pending tab only):** push `{ rowKey: card.cardKey, kinds: [QUEUE_KIND.release], weight: card.memberIds.length }` when `card.releaseBlock === null`, and `rowsByKey[card.cardKey] = { visitId, label: `${card.label} — ${card.patientName}`, assignedTo: null, memberIds: card.memberIds }`. Render a `RowSelectCheckbox` in the grouped card's (currently empty, ~L1121) checkbox cell under the same condition. Claim/unclaim/delete stay single-only (unchanged). The client caps stay `MAX_BULK_ROWS` rows / `MAX_BULK_RECORDS` weight; the server accepts up to `MAX_BULK_RECORDS` ids.
- [ ] **Step 5: Released today.** When `releasedTab && !receptionView && canActOnResult(session.role, card.section)`: single → `<Link href={`/staff/queue/${card.testRequestId}?undo=1`}>Undo…</Link>`; grouped → `<Link href={card.href}>Undo…</Link>` (consolidated page shows per-report Undo). Style as "Open →" with `text-[color:var(--color-brand-text-soft)]`.
- [ ] **Step 6: Bulk bar.**

```tsx
const releaseKeys = known(keysByKind[QUEUE_KIND.release]);
const releaseIds = Array.from(new Set(releaseKeys.flatMap((k) => rowsByKey[k]!.memberIds ?? [k])));
const [medium, setMedium] = useState<ReleaseMedium>("physical");

function release() {
  if (pending || releaseIds.length === 0) return;
  const keys = releaseKeys;
  setRunning("release");
  start(async () => {
    const result = await releaseTestsAction({ testRequestIds: releaseIds, medium });
    if (!result.ok) { alert(result.error); return; }
    const msg = bulkReleaseMessage(releaseIds.length, result, labelsByTestId(rowsByKey));
    setOutcome(result.warnings.length ? `${msg}\n${result.warnings.join("\n")}` : msg);
    clearKeys(keys);
    closePanel();
    router.refresh();
  });
}
```

Render (between Unclaim and Delete, when `releaseKeys.length > 0`): `<select aria-label="Release medium">` over `RELEASE_MEDIUM_OPTIONS` + `<Button variant="brand">{running === "release" && pending ? "Releasing…" : `Release ${n(releaseIds.length)}`}</Button>`. `running` union gains `"release"`. Panel hint → `Chemistry panels are claimed from their own page.` only when a panel is on the page AND not on the pending tab (pass `filter` or a boolean prop).
- [ ] **Step 7: DOM test** (`queue-bulk-bar.test.tsx`, jsdom; mock `./actions`, `@/lib/actions/visits/queue-deletion`, `next/navigation`): (a) one single + one panel selected → action gets flattened, de-duplicated ids and `medium:"physical"`; label "Release 3 tests"; (b) outcome text lists a skipped panel member by its card label; (c) warnings are appended.
- [ ] **Step 8:** `npm test && npm run typecheck && npm run lint`. **Commit** `feat(queue): release from Pending release (row, panel, bulk) and Undo shortcut on Released today`.

---

### Task 14: Dashboards

**Files:** `src/lib/dashboards/cards.ts` (+ `cards.test.ts` if pinned), `_dashboards/lab-dashboard.tsx`, `_dashboards/reception-dashboard.tsx`

- [ ] **Step 1: Registry**

```ts
{ id: "lab.ready_for_release",   label: "Ready for release", roles: ["medtech", "xray_technician", "pathologist"], group: "snapshot" },
{ id: "reception.released_today", label: "Released today",   roles: ["reception"], group: "snapshot" },
```

- [ ] **Step 2: Lab card**

```ts
// Finished results waiting to go out — the Pending release tab's count in
// this role's sections (pathologist: all). Not money-gated: an unpaid one
// still needs chasing, and the tab shows it with the reason.
const readyForReleasePromise = show("lab.ready_for_release")
  ? (() => {
      let q = supabase
        .from("test_requests")
        .select("id, services!inner(section, kind), visits!inner(id)", { count: "exact", head: true })
        .eq("status", "ready_for_release")
        .eq("is_package_header", false)
        .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
        .is("deleted_at", null)
        .is("visits.deleted_at", null);
      if (sections !== null) q = q.in("services.section", sectionList);
      return q;
    })()
  : SKIP_COUNT;
```

Add to the `Promise.all` tuple, stats (`readyForRelease`, `readyForReleaseError`) and the file's error-report list (mirror `releasedToday`). Render with `StatCard label="Ready for release" hint="All dates — finished, waiting to go to the patient" href="/staff/queue?filter=pending_release" accent={n>0?"warn":"default"}` in "My queue" for medtech/xray and in the pathologist's first grid; include it in that grid's visibility flag.
- [ ] **Step 3: Reception.** Pending tile → `label="Waiting for the lab to release"`, `hint="All dates — finished results; the lab releases them"` (query and href unchanged). New count using `manilaDayWindowUtc(0)` from `@/lib/dates/manila` (Manila midnight-correct):

```ts
show("reception.released_today")
  ? supabase
      .from("test_requests")
      .select("id, services!inner ( kind ), visits!inner ( id )", { count: "exact", head: true })
      .eq("status", "released")
      .gte("released_at", todayWindow.startIso)
      .lt("released_at", todayWindow.endIso)
      .eq("is_package_header", false)
      .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      .is("deleted_at", null)
      .is("visits.deleted_at", null)
  : SKIP_COUNT,
```

`StatCard label="Released today" hint="Ready to print at the counter" href="/staff/queue?filter=released_today"`; add to `hasSnapshot`. Add a `manilaDayWindowUtc` boundary test if none exists (fake timers at 23:59 and 00:01 Manila).
- [ ] **Step 4:** test + typecheck + lint (route-name guard green). **Commit** `feat(dashboards): lab Ready for release card; reception release tiles`.

---

### Task 15: Reception bell alert on release

**Files:** Create `src/lib/staff/release-notifications.ts` (+ test); modify `src/components/staff/notification-bell.tsx`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { foldReleaseEvent, isFreshRelease, releaseEventKey } from "./release-notifications";

describe("release bell items", () => {
  const ev = (over = {}) => ({ testRequestId: "t1", releasedAt: "2026-09-28T08:00:00Z", visitId: "v1",
    who: "Cruz, Ana", visitNumber: "0044", ts: 1_000, ...over });
  it("keys an event by test + release instant, so a later update of the same release is a repeat", () => {
    expect(releaseEventKey(ev())).toBe("t1@2026-09-28T08:00:00Z");
  });
  it("judges freshness from released_at", () => {
    const now = Date.parse("2026-09-28T08:01:00Z");
    expect(isFreshRelease({ status: "released", released_at: "2026-09-28T08:00:00Z" }, now)).toBe(true);
    expect(isFreshRelease({ status: "released", released_at: "2026-09-28T07:50:00Z" }, now)).toBe(false);
  });
  it("drops a repeated event", () => {
    const a = foldReleaseEvent({ items: [], seen: new Set() }, ev());
    const b = foldReleaseEvent(a, ev({ ts: 2_000 }));
    expect(b.items).toHaveLength(1);
    expect(b.isNew).toBe(false);
  });
  it("merges one visit's releases within a minute, starts a new item after", () => {
    const a = foldReleaseEvent({ items: [], seen: new Set() }, ev());
    const b = foldReleaseEvent(a, ev({ testRequestId: "t2", ts: 20_000 }));
    expect(b.items).toHaveLength(1);
    expect(b.items[0].title).toBe("2 results released for Cruz, Ana");
    const c = foldReleaseEvent(b, ev({ testRequestId: "t3", ts: 200_000 }));
    expect(c.items).toHaveLength(2);
    expect(new Set(c.items.map((i) => i.id)).size).toBe(2);
    expect(c.isNew).toBe(true);
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement** `release-notifications.ts`: `releaseEventKey`, `isFreshRelease(row, now, windowMs = 120_000)`, `foldReleaseEvent(state, ev) → { items, seen, isNew }` — dedupe via `seen`; merge into the newest item for the same `visitId` whose `ts` is within 60 s (bump `count`, retitle); otherwise new item with id `released-${visitId}-${ev.ts}`; title `1 result released for X` / `N results released for X`; subtitle `Visit #0044 · <manilaTime>`; href `/staff/queue?filter=released_today`; `kind: "release"`.
- [ ] **Step 4: Bell.** `RELEASE_ROLES = ["reception"]`, `subscribesToReleases`, a `seenRef = useRef(new Set<string>())`, and a channel handler on `{ event: "UPDATE", schema: "public", table: "test_requests", filter: "status=eq.released" }`: skip headers and non-fresh rows; look up `services(name, kind)` and `visits(visit_number, patients(first_name,last_name))`; skip `isDoctorKind` (Mark done isn't a lab release); then `setItems` via `foldReleaseEvent` and bump `unread` when `isNew`. Add `"release"` to `NotificationItem.kind`; include the flag in the hide/early-return checks and effect deps. (Default replica identity: `payload.old` has only the PK — hence `released_at` freshness + event key, not an old/new status compare.)
- [ ] **Step 5:** tests + typecheck + lint. Runtime check in Task 17. **Commit** `feat(bell): reception hears when results are released`.

---

### Task 16: User guide + pointer

- [ ] `docs/drmed-user-guide.html`: Release card (~L346) → "The lab releases from the Queue — the test's page, a chemistry report's page, or Pending release (one row, a whole panel, or several at once) — or from the visit page."; `ready for release` (~L371) → "Finalised. The lab releases it once the visit is paid."; `#lab-after`: Release on bench page / Pending release / bulk incl. panels / combined report releases whole and is refused while any test on it is unfinished / Undo from the test page, the report page or Released today → Undo…; reception: "Waiting for the lab to release" + "Released today" tiles + bell alert; lab dashboard "Ready for release". Correct the notification wording (Physical/Pickup send nothing).
- [ ] Bump version/date (v2.44, 28 Sep 2026) and the `CLAUDE.md` pointer line citing it.
- [ ] **Commit** `docs(guide): lab releases from the queue`.

---

### Task 17: End-to-end verification (local stack, real triggers)

- [ ] `npm test && npm run typecheck && npm run lint && npm run build` — green; logs to files, tails in the PR.
- [ ] Local dev server; admin → **View as Medical Tech** (verify with `browser_snapshot`/`browser_evaluate`, screenshots only at the end):
  1. Paid visit, FECALYSIS inside a package → bench "Release to patient" → released; Pending release no longer lists it; visit page shows released; package header waits for siblings. Audit row has `source:"queue"`; `result.notified` audit present (skipped for Physical).
  2. Unpaid visit → disabled with the payment text; no checkbox. Waived and HMO visits → releasable.
  3. Consent gate ON (admin setting) + patient without consent → disabled with consent text; flip consent off in another tab after page load, click Release → inline DB refusal in the same wording.
  4. Chemistry panel: all ready → "Release panel" / "Release report" releases all; select one member only via a page split (`?size=5`) → whole report released + "Also released…"; mixed report (set one member to `result_uploaded` locally) → refused "isn't finished", nothing released, no notification audit.
  5. Bulk: FECALYSIS + a panel + a row from another visit → one outcome message; counts right.
  6. Released today → Undo… → bench opens with dialog open; undo with reason → back to ready. Consolidated page Undo reverts the whole report.
  7. **View as X-ray Tech** on an imaging result — works; medtech cannot see it.
  8. **View as Reception**: no Release/Undo anywhere (list, bench, consolidated); forged call from devtools to `releaseTestsAction` refused; dashboard tiles; release as medtech in a second browser → reception bell "1 result released for …" within seconds; a second test on the same visit within a minute merges.
  9. Refresh without realtime: with the list open in tab A, release in tab B from the bench page → tab A list, tab B bench and the `/staff` dashboard all show the new state after navigation (revalidation, not only RealtimeRefresher).
  10. Inactive (merged) patient → no Release/Undo on bench and consolidated pages.
- [ ] Note in the PR: residual race (report changed between plan and write) is detected, withheld from the patient, and surfaced; the portal fails closed.

---

## Follow-ups (not in this PR — surface to the owner)

- True atomic whole-report release would need an RPC with row locks (a migration); the queue and visit page detect and withhold instead.
- (The visit-page whole-report rule, admin card and email alert moved into this PR as Tasks 18–20.)
- Pre-existing: finalising a settled chemistry report with no sign-off releases it (finalise-consolidated.ts step 9) but sends the patient NO "your result is ready" notice, and can release part of a report when some members need sign-off. Found by the rev-5 Codex review; out of scope here — surface to the owner.

## Owner-added scope (2026-09-30) — Tasks 18–20 (rev 4)

The owner moved all three follow-ups INTO this PR and approved the whole-combined-report-or-nothing rule for the visit page too. Build order: Tasks 1–12, 14–20, then Task 13 last (open PR #254 rewrites the same queue list/bulk bar — rebase onto it if it has merged by then and reuse its panel selection key `panel:<visit>:<group>` / `fetchPanelMembers` instead of duplicating), then Tasks 16–17.

**Owner decision 2026-09-30 (privacy, RA 10173):** the staff "Results released" email carries the patient's **first name + last initial**, the visit number and a **count** of results — never test names, result values or contact details (matches the online-booking alert). Staff see the test names in the app, behind sign-in and the audit trail.

### Change to Task 8 (rev 4): the per-visit pipeline is a shared helper

Build Task 8's steps 4–7 (membership reads, fail-closed, `planReportRelease`, `releaseRows`, post-write completeness, notify) **not inline in `releaseTestsAction`** but as one exported function, so the visit page (Task 18) uses the same code path:

```ts
// src/lib/actions/visits/release-reports.ts
import "server-only";
export type VisitReleaseOutcome = {
  /** Selected ids the write actually released (authoritative RETURNING). */
  changedIds: string[];
  /** Pulled-in report members (not selected) the write released. */
  alsoReleasedIds: string[];
  /** Selected ids NOT released, with the reason (plan refusal, fail-closed read, DB error, raced). */
  skipped: SkippedRow[];
  warnings: string[];
  /** Released rows that are plain or on a report verified complete — the only rows announced. */
  announced: ReleasedRow[];
};

/**
 * Release `selectedIds` (all on `visitId`, already eligibility-checked by the
 * caller) with the whole-report rule. Never releases part of a combined
 * report on purpose; detects and withholds when a race makes it partial.
 * Notifies the patient (notifyReleased) and schedules the staff alert
 * (Task 20) for `announced` only.
 */
export async function releaseVisitSelection(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  selectedIds: readonly string[];
  medium: ReleaseMedium;
  auditMeta: Record<string, unknown>;
}): Promise<VisitReleaseOutcome>
```

It never returns `{ok:false}`: every failure lands the affected selected ids in `skipped` (read error → "Couldn't check which report these tests belong to — try again."; `releaseRows` error → its translated message for every selected id; too many after expansion → `"Too many tests once whole reports are included — select fewer."` for every selected id). `releaseTestsAction` keeps its contract (steps 1–3, 8–9) and calls this per visit. The fake in-memory Supabase used by Task 8's tests goes in `src/lib/actions/visits/fake-release-db.ts` (a non-test helper module; export `makeFakeReleaseDb(seed)` returning `{ client, rows, links, failNext(table, phase) }`), so Task 18's tests reuse it. The helper module is a test fixture — add it to any guard allowlist that scans `src/lib/actions/**` only if a guard trips, with the justification "test fixture, never imported by app code"; prefer naming/placement that no guard scans if the guard supports an ignore for fixtures (read `write-guards.test.ts` / `query-surfaces.test.ts` scan roots first).

Register `release-reports.ts` in `query-surfaces.test.ts` (`SURFACES` "lab" — it reads `test_requests` through the `result_test_requests` embed only, so check whether the scanner even sees it; register only if it does) and confirm `write-guards.test.ts` stays green.

Task 8's tests stay as written (they exercise the helper through the action); add two direct helper tests: (a) `announced` excludes the rows of an incomplete report; (b) `releaseRows` error → every selected id skipped with the translated message, nothing announced.

### Change to Task 9a (rev 4): outcome text from counts

`releaseOutcomeText` takes `{ changedCount: number; alsoReleasedCount: number; skipped: readonly SkippedRow[]; warnings: readonly string[] }` (not the queue result with id arrays), so the visit page's actions — which return counts — share it. Queue callers pass `{ changedCount: res.changedIds.length, alsoReleasedCount: res.alsoReleasedIds.length, skipped: res.skipped, warnings: res.warnings }`. Its tests use the count form.

---

### Task 18: Visit page follows the whole-report rule

**Behaviour change:** today the visit page can release one member of a combined chemistry report, leaving the patient with a report the portal will not serve (it needs every linked test released). After this task, releasing any member of a combined report releases every ready member of that report, or refuses with the same message the queue gives.

**Files:** modify `visits/[id]/actions.ts` (`releaseTestAction`, `releaseSelectedAction`, `releaseAllReadyComponentsAction`), `visits/[id]/release-button.tsx`, `visits/[id]/release-all-button.tsx`, `visits/[id]/bulk-action-bar.tsx`, `visits/[id]/page.tsx`; modify `src/lib/queue/report-release-scope.ts` (+test); create `visits/[id]/release-actions.test.ts`, `visits/[id]/release-button.test.tsx`.

- [ ] **Step 1: Failing pure test — page preflight shares the planner's rule.** Add to `report-release-scope.test.ts`:

```ts
import { reportReleaseBlock, REPORT_REFUSAL } from "./report-release-scope";

describe("reportReleaseBlock", () => {
  const mem = (status: string, deleted = false) => ({ status, deleted });
  it("is null when every live member is ready or released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released")])).toBeNull();
  });
  it("refuses a deleted, unreleased member first", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("ready_for_release", true)])).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("counts unfinished live members", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("result_uploaded"), mem("in_progress")]))
      .toBe(REPORT_REFUSAL.notFinished(2));
  });
  it("ignores a deleted member that was released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released", true)])).toBeNull();
  });
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** in `report-release-scope.ts` and make `planReportRelease` use it (its existing tests must stay green — same order: structural, doctor, then this):

```ts
/** The status/deletion half of the whole-report rule, shared by the planner and the visit page's preflight. */
export function reportReleaseBlock(members: ReadonlyArray<{ status: string; deleted: boolean }>): string | null {
  if (members.some((x) => x.deleted && x.status !== "released")) return REPORT_REFUSAL.deletedMember;
  const unfinished = members.filter((x) => !x.deleted && x.status !== "ready_for_release" && x.status !== "released");
  return unfinished.length > 0 ? REPORT_REFUSAL.notFinished(unfinished.length) : null;
}
```

In `planReportRelease` replace the two inline branches with `else reason = reportReleaseBlock(mems);`. **Commit** `refactor(queue): share the whole-report status rule`.

- [ ] **Step 4: Failing action tests** (`visits/[id]/release-actions.test.ts`; mock `server-only`, `next/cache` (capture `revalidatePath`), `next/headers`, `@/lib/auth/require-staff` (hoisted role), `@/lib/supabase/admin` (for `assertVisitPatientActive` → active), `@/lib/audit/log`, `@/lib/notifications/notify-released`, `@/lib/notifications/notify-released-bulk`, `@/lib/notifications/release-staff-alert` (Task 20; record calls), `@/lib/supabase/server` → `makeFakeReleaseDb(...)`). Seed: visit `v1` paid, live, active patient; chemistry report `r1` = `a`,`b` (both ready), plain row `x` (ready), package header `h` with components `c1` (ready, plain) and `c2` (ready, on report `r1`… use `r2` = `c2`,`d` ready). Cases:
  1. `releaseTestAction("a","v1","email")` → `{ ok: true, changedCount: 1, alsoReleasedCount: 1, skipped: [], warnings: [] }`; `a` and `b` released; `notifyResultsReleasedBulk` called once with both ids; alert scheduled once for `v1` with 2 rows.
  2. Mixed: `b` = `result_uploaded` → `releaseTestAction("a",…)` → `{ ok:false, error: REPORT_REFUSAL.notFinished(1) }`; nothing released; no notify; no alert.
  3. Deleted unreleased sibling `b` → `{ ok:false, error: REPORT_REFUSAL.deletedMember }`.
  4. Fail-closed: `failNext("result_test_requests","read")` → `{ ok:false, error:"Couldn't check which report these tests belong to — try again." }`, no write.
  5. Plain row `x` → released alone, `notifyResultReleased` (single) called, `changedCount: 1, alsoReleasedCount: 0` — same patient-facing behaviour as before.
  6. `releaseSelectedAction("v1", ["a","x"], "physical")` → `{ ok:true, count: 2, alsoReleasedCount: 1, skipped: [], warnings: [] }`.
  7. `releaseSelectedAction` with `a` on a mixed report and `x` plain → `{ ok:true, count:1, alsoReleasedCount:0, skipped:[{ id:"a", reason: REPORT_REFUSAL.notFinished(1) }], warnings:[] }`; `x` released.
  8. `releaseSelectedAction` where every id is refused → `{ ok:false, error: <first reason> }` (keeps the old "nothing released = error" contract, now with the reason instead of the generic string; the generic `"None of the selected tests are ready to release."` stays for the no-candidates case).
  9. `releaseAllReadyComponentsAction("h","v1","physical")` → `c1`, `c2` and the pulled-in `d` released; `changedCount: 2, alsoReleasedCount: 1`; the package header is not written by the action.
  10. `releaseAllReadyComponentsAction` with `d` at `result_uploaded` → `c1` released, `c2` refused → `{ ok:true, changedCount:1, alsoReleasedCount:0, skipped:[{ id:"c2", reason: notFinished(1) }], warnings:[] }`.
  11. Race: fake `releaseRows` path returns only `a` of `a`,`b` (use the fake's `failNext("test_requests","update-partial")`) → `{ ok:true, …, warnings:[<the "couldn't confirm" / "changed while releasing" text from Task 8>] }`, no notify, no alert.
  12. Inverse race (Codex rev 5): selected `a` becomes ineligible between plan and write, the write releases only the pulled-in `b` → `releaseTestAction` returns `{ ok: true, changedCount: 0, alsoReleasedCount: 1, skipped:[{id:"a",…}], warnings:[…] }` — never a bare error that drops the real write; same for `releaseSelectedAction` (`count: 0`) and the package action.
  13. Package action returns `changedCount` = components the write released (not the render-time ready count): partial refusal → `changedCount: 1`; a component released by someone else between render and click → `changedCount` excludes it and it is in `skipped` with the "Released by someone else or changed just now." reason; a pulled-in member outside the package counts only in `alsoReleasedCount`.
  14. Every action: `revalidatePath` args equal Task 4's `revalidateReleaseSurfaces("v1")` list, on success AND on a refusal after the visit check.

- [ ] **Step 5:** run → FAIL.
- [ ] **Step 6: Implement.** New result types in `actions.ts`:

```ts
/** The three visit-page lab release actions (rev 5: new names — existing types are NOT widened). */
export type VisitReleaseResult =
  | { ok: true; changedCount: number; alsoReleasedCount: number; skipped: SkippedRow[]; warnings: string[] }
  | { ok: false; error: string };
export type VisitBulkReleaseResult =
  | { ok: true; count: number; alsoReleasedCount: number; skipped: SkippedRow[]; warnings: string[] }
  | { ok: false; error: string };
```

Signatures after this task (enumerated — grep every caller and update only these):
- `releaseTestAction(...) : Promise<VisitReleaseResult>` (callers: `release-button.tsx`).
- `releaseAllReadyComponentsAction(...) : Promise<VisitReleaseResult>` (callers: `release-all-button.tsx`).
- `releaseSelectedAction(...) : Promise<VisitBulkReleaseResult>` (callers: `bulk-action-bar.tsx`; Task 6's pin test updated).
- **Unchanged:** `ReleaseResult` (`{ok:true} | {ok:false,error}`) stays as is for `releasePackageHeaderAction`, `waiveVisitBalanceAction`, mark-done and any other current user; `BulkSelectionResult` (`{ok:true,count} | …`) stays as is for `undoReleaseSelectedAction` (its caller shows the count), sample deletion and any other current user. `npm run typecheck` must pass without touching those callers.

- `releaseTestAction`: keep medium check, `requireActiveStaff`, `refuseIfVisitDeleted`, the candidate read and its two messages (not ready / outside sections — reuse `RELEASE_REFUSAL.notReady` / `.section`, identical text). Replace the write/audit/notify with:

```ts
const out = await releaseVisitSelection({
  supabase, session, visitId, selectedIds: [testRequestId], medium: releaseMedium,
  auditMeta: { source: "visit_page", bulk: false, selection: false },
});
revalidateReleaseSurfaces(visitId);
// A write happened if EITHER list has rows (a pulled-in sibling can release
// even when the selected row raced away) — then report it, never a bare error.
if (out.changedIds.length === 0 && out.alsoReleasedIds.length === 0) {
  return { ok: false, error: out.skipped[0]?.reason ?? RELEASE_REFUSAL.notReady };
}
return {
  ok: true, changedCount: out.changedIds.length, alsoReleasedCount: out.alsoReleasedIds.length,
  skipped: out.skipped, warnings: out.warnings,
};
```

- `releaseSelectedAction`: keep input checks and the "None of the selected tests are ready to release." early return when the section-scoped candidate read is empty (move that read in front — it is the existing read; `releaseRows` repeats it, which is fine). Then `releaseVisitSelection({ …, selectedIds: scopedIds, auditMeta: { source: "visit_page", bulk: true, selection: true } })`; ids the caller sent but that were not candidates go into `skipped` with `RELEASE_REFUSAL.notReady`. Return per cases 6–8 and 12, with the same "a write happened if either list has rows" rule.
- `releaseAllReadyComponentsAction`: keep the header check and the section-scoped ready-components read (drop the `scopedIds === null` branch — always read the ids, so `releaseVisitSelection` gets an explicit list); if empty → existing "No components are ready to release."; else `releaseVisitSelection({ …, selectedIds: componentIds, auditMeta: { source: "visit_page", bulk: true, package_header_id: headerId } })`; return `changedCount` = `out.changedIds.length` (components this write released) separately from `alsoReleasedCount`; `{ ok:false, error: first reason }` only when both lists are empty (cases 9, 10, 12, 13).
- All three: `revalidateReleaseSurfaces(visitId)` on every path after the visit check (case 14). Remove the now-unused inline notify/audit code; `notifyResultReleased` / `notifyResultsReleasedBulk` imports leave this file if nothing else uses them.

- [ ] **Step 7: Page preflight + UI.** In `page.tsx`, next to `reportScopeByTrId` (~L355), build `reportBlockByTrId: Record<string, string>` from the page's own rows: for each report scope, `reportReleaseBlock(scope.memberIds.map(id => ({ status: statusById.get(id) ?? "unknown", deleted: false })))`, and if `sharedReportIds` shows members off this visit's live list (`fetchSharedReportTestIds`), treat the report as blocked with `REPORT_REFUSAL.deletedMember` only when that off-list member is known deleted-and-unreleased — otherwise leave it to the server (display only; the action is the guard). Pass to `TestAction`: `releaseLabel` = `reportScope ? \`Release report (${reportScope.memberIds.length} tests)\` : "Release"` and `releaseBlock = reportBlockByTrId[t.id] ?? null`.
  - `ReleaseButton` gets `label?: string` and `blockReason?: string | null`: disabled when `blockReason`, which is shown under the button in the same style as `QueueReleaseButton`'s block text. Outcomes go through `useReleaseOutcome()?.show(releaseOutcomeText({ changedCount: res.changedCount, alsoReleasedCount: res.alsoReleasedCount, skipped: res.skipped, warnings: res.warnings }))` (count form, see the Task 9a change). `{ok:false}` keeps `alert(result.error)` (existing visit-page pattern) when no provider is mounted, else `show(error)`.
  - Mount `<ReleaseOutcomeProvider>` (Task 9a) around the visit page's main content.
  - Rows whose `reportBlockByTrId` is set: render `RowSelectCheckbox eligibility="release"` only when not blocked (~L1182 and the standalone-row equivalent), so bulk can't select a row the page already knows is refused.
  - `ReleaseAllButton`: same outcome reporting, using the action's `changedCount` (never the render-time `readyCount`).
  - `BulkActionBar`: add a release-expansion preview mirroring the existing violet undo banner (~L99-110): from `reportScopeByTrId`, count ready members of touched reports not in `releaseIds` (pass a `readyIds: string[]` prop from the page) → `"Releasing these also releases N other test(s) on the same combined report."`. Replace the "Released X of Y selected — the rest were already handled…" alert with the provider notice built from the result (count, also-released, each skipped reason, warnings).
- [ ] **Step 8: DOM test** (`release-button.test.tsx`, jsdom; mock the actions module): blocked → disabled + reason text; label "Release report (3 tests)" rendered; ok result with `alsoReleasedCount: 2` → provider notice contains "Also released 2 other tests on the same combined report." after the button unmounts.
- [ ] **Step 9:** `npm test && npm run typecheck && npm run lint`. **Commit** `feat(visits): the visit page releases a combined report whole or not at all`.

---

### Task 19: Admin dashboard "Ready for release" card

**Files:** `src/lib/dashboards/cards.ts` (+ `cards.test.ts` if it pins ids), `_dashboards/admin-dashboard.tsx`; create `src/lib/dashboards/ready-for-release.ts` (+test).

- [ ] **Step 1: Failing pure test**

```ts
// src/lib/dashboards/ready-for-release.test.ts
import { describe, expect, it } from "vitest";
import { readyForReleaseHint } from "./ready-for-release";

describe("readyForReleaseHint", () => {
  it("names how many wait on payment", () => {
    expect(readyForReleaseHint(5, 3)).toBe("2 waiting on payment");
    expect(readyForReleaseHint(1, 0)).toBe("1 waiting on payment");
  });
  it("falls back to the plain hint when all are paid or none wait", () => {
    expect(readyForReleaseHint(4, 4)).toBe("All dates — finished, waiting to go to the patient");
    expect(readyForReleaseHint(0, 0)).toBe("All dates — finished, waiting to go to the patient");
  });
  it("never shows a negative count if the two reads disagree", () => {
    expect(readyForReleaseHint(2, 3)).toBe("All dates — finished, waiting to go to the patient");
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement**

```ts
// src/lib/dashboards/ready-for-release.ts
// Hint for the admin "Ready for release" card. `total` = every finished lab
// result waiting to go out; `settled` = those on a paid / waived / HMO visit.
// The difference is what's stuck on payment (the release trigger, 0133).
export function readyForReleaseHint(total: number, settled: number): string {
  const waiting = total - settled;
  return waiting > 0 ? `${waiting} waiting on payment` : "All dates — finished, waiting to go to the patient";
}
```

- [ ] **Step 4: Registry** — `cards.ts`: `{ id: "admin.ready_for_release", label: "Ready for release", roles: ["admin"], group: "operations" }` (update `cards.test.ts` if it pins the list).
- [ ] **Step 5: Queries** — in `loadAdminStats`, two tuple elements, both `show("admin.ready_for_release") ? … : SKIP_COUNT`:

```ts
// Finished lab results waiting to go out, all sections (the Pending release
// tab as an admin sees it) — and how many of them are on a settled visit.
supabase
  .from("test_requests")
  .select("id, services!inner ( kind ), visits!inner ( id )", { count: "exact", head: true })
  .eq("status", "ready_for_release")
  .eq("is_package_header", false)
  .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
  .is("deleted_at", null)
  .is("visits.deleted_at", null),
// …same chain plus:
  .or(MONEY_SETTLED_VISITS_OR, { foreignTable: "visits" }),
```

`namedResults` gets `ready_for_release` and `ready_for_release_settled`; `stats` gets `readyForRelease`, `readyForReleaseSettled`, `readyForReleaseError: Boolean(a.error || b.error)`.
- [ ] **Step 6: Render** in the Operations grid (add to `showOperations`):

```tsx
{show("admin.ready_for_release") && (
  <StatCard label="Ready for release" value={stats.readyForRelease}
    hint={readyForReleaseHint(stats.readyForRelease, stats.readyForReleaseSettled)}
    href="/staff/queue?filter=pending_release"
    accent={stats.readyForRelease > 0 ? "warn" : "default"} error={stats.readyForReleaseError} />
)}
```

- [ ] **Step 7:** `npm test` (route-name guard, `query-surfaces`, cards) + typecheck + lint. **Commit** `feat(dashboards): admin Ready for release card with the payment hint`.

---

### Task 20: Email alert to reception when results are released (MIGRATION 0192)

Migration number **0192 is claimed** (`npm run claim -- list`). 0191 belongs to open PR #254.

**Files:** create `supabase/migrations/0192_result_released_staff_alert.sql`, `src/lib/notifications/release-staff-alert-content.ts` (+test), `src/lib/notifications/release-staff-alert.ts` (+test); modify `src/lib/notifications/staff-alerts.ts`, `staff-alerts.test.ts` (only if a case needs updating), `src/lib/actions/visits/release-reports.ts` (schedule the alert), `src/types/database.ts` (only if `npm run db:types` changes it — a CHECK change normally doesn't).

- [ ] **Step 1: Failing registry test.** Add `"result_released"` to the expected alert set by adding the key to `STAFF_ALERT_KEYS` first → `staff-alerts.test.ts` fails ("CHECK list matches" and "every key is seeded") until the migration exists. That is the failing test.
- [ ] **Step 2: Registry entry** (`staff-alerts.ts`):

```ts
result_released: {
  key: "result_released",
  label: "Results released",
  description:
    "Sent when the lab releases results, so the counter can print them for a waiting patient. One email per release per visit. It shows the patient's first name and last initial, the visit number and how many results — never which tests, the results themselves, or contact details.",
  defaultRoles: ["reception"],
  sentAction: "test_request.released.staff_alert_sent",
},
```

- [ ] **Step 3: Migration** (mirror 0157/0186 exactly; the test's regex needs the literal `staff_alert_settings_key_check check (alert_key in (…))` with no nested parentheses; list ALL seven keys):

```sql
-- 0192 — Email Alerts: "Results released" (lab-release-on-queue, Task 20).
-- Reception can be emailed when the lab releases results, so the counter can
-- print them for a waiting patient. Content is name + visit # + a count only
-- (owner decision 2026-09-30, RA 10173) — see release-staff-alert-content.ts.
-- Additive: widens the key CHECK and seeds the settings row (enabled by
-- default, like every alert). Recipients default to reception in the app
-- registry (STAFF_ALERTS) until an admin changes them in Email Alerts.

alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest', 'online_booking', 'released_payment_removed', 'stale_bookings', 'result_released'));

insert into public.staff_alert_settings (alert_key)
values ('result_released')
on conflict (alert_key) do nothing;

do $$
begin
  if not exists (select 1 from public.staff_alert_settings where alert_key = 'result_released') then
    raise exception '0192 post-check: the result_released alert row is missing';
  end if;
end;
$$;
```

Before writing it, re-read the newest migration that touches `staff_alert_settings_key_check` on `origin/main` (0186 today) and copy its key list — if another branch has since merged a new key, include it too. Apply locally with `supabase migration up` (never `db reset` the shared local DB), then `npx vitest run src/lib/notifications/staff-alerts.test.ts` → PASS.
- [ ] **Step 4: Failing content test**

```ts
// src/lib/notifications/release-staff-alert-content.test.ts
import { describe, expect, it } from "vitest";
import { buildReleaseAlertEmail, patientShortName } from "./release-staff-alert-content";

const base = { firstName: "Ian", lastName: "Jamila", visitNumber: "0044", count: 3,
  visitUrl: "https://drmed.ph/staff/visits/v1" };

describe("release staff alert email", () => {
  it("shortens the name to first name + last initial", () => {
    expect(patientShortName("Ian", "Jamila")).toBe("Ian J.");
    expect(patientShortName("Ian", null)).toBe("Ian");
    expect(patientShortName(null, "Jamila")).toBe("A patient");
  });
  it("says how many results, for whom, on which visit", () => {
    const e = buildReleaseAlertEmail(base);
    expect(e.subject).toBe("3 results released for Ian J. — visit #0044");
    expect(e.text).toContain("https://drmed.ph/staff/visits/v1");
    expect(buildReleaseAlertEmail({ ...base, count: 1 }).subject).toBe("1 result released for Ian J. — visit #0044");
  });
  it("never carries the full surname, test names or contact details", () => {
    const e = buildReleaseAlertEmail(base);
    for (const part of [e.subject, e.text, e.html]) expect(part).not.toContain("Jamila");
    // The input type has no test-name / phone / email fields — structural rule.
  });
  it("escapes a hostile first name in the HTML and keeps the subject one line", () => {
    const e = buildReleaseAlertEmail({ ...base, firstName: "<b>x</b>\nBcc: y" });
    expect(e.html).not.toContain("<b>x</b>");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });
  it("says why the recipient gets it and where to change it", () => {
    expect(buildReleaseAlertEmail(base).text).toContain("Admin Tools › Email Alerts");
  });
});
```

- [ ] **Step 5:** FAIL. **Step 6: Implement** `release-staff-alert-content.ts` modelled on `src/lib/appointments/booking-alert-content.ts` (read it first; same `renderEmailShell` / `emailParagraph` / `emailDetailBox` / `emailButton(label, url, "cyan")` / `escapeHtml` helpers from `@/lib/notifications/branded-email`; strip CR/LF from anything in the subject). Input type `{ firstName: string | null; lastName: string | null; visitNumber: string; count: number; visitUrl: string }` — nothing else. Button "Open the visit" → `/staff/visits/<id>` (rev 5: not Released today, which empties at Manila midnight while the email stays in the inbox; the visit page is where reception prints). Received-note: `You're receiving this because you're switched on for the "Results released" alert. An admin can change who gets it under Admin Tools › Email Alerts.`
- [ ] **Step 7: Failing sender test** (`release-staff-alert.test.ts`; mock `server-only`, `next/server` (`after: (fn) => queued.push(fn)`), `@/lib/supabase/admin` (visit row: `visit_number`, `is_sample`, `patients ( first_name, last_name )`), `./staff-alert-recipients`, `./email` (`sendEmail` records calls), `@/lib/audit/log`, `@/lib/observability/report-error`):
  1. `scheduleReleaseStaffAlert("v1", 3)` queues exactly one `after` callback and does no I/O until it runs.
  2. Running it with recipients `["a@x","b@x"]` → `sendEmail` twice with the built subject; one `audit` row: `action: "test_request.released.staff_alert_sent"`, `actor_type: "system"`, `resource_type: "visit"`, `resource_id: "v1"`, `metadata: { recipients: 2, sent: 2, failed: 0, count: 3 }` (no addresses).
  3. Sample visit (`is_sample: true`) → no email; audit with `skipped: "sample visit"`.
  4. `count === 0` → nothing queued.
  5. No recipients → no email; audit `skipped` reason as in booking-alert (`turned off in Email Alerts` / `nobody is switched on…`).
  6. A thrown visit read → `reportError` called, nothing rethrown.
  7. The visit read returns `{ data: null, error }` → no email, `reportError` called with the error, no audit row claiming a send.
  8. The visit was deleted (or is missing) by the time the deferred callback runs → the live-filtered read returns no row → no email; audit `skipped: "visit deleted or missing"`.
- [ ] **Step 8:** FAIL. **Step 9: Implement** `release-staff-alert.ts` modelled on `src/lib/appointments/booking-alert.ts` (read it first):

```ts
import "server-only";
import { after } from "next/server";
// …createAdminClient, resolveStaffAlertRecipients, sendEmail, audit, reportError, SITE, buildReleaseAlertEmail

/**
 * Queue the reception "Results released" email for one release action on one
 * visit. Runs after the response (never delays the release), never throws.
 * `count` = rows actually announced (verified released: plain rows, or a
 * combined report confirmed complete) — callers pass releaseVisitSelection's
 * `announced.length`, never the selection size.
 */
export function scheduleReleaseStaffAlert(visitId: string, count: number): void {
  if (count <= 0) return;
  after(() => sendReleaseStaffAlert(visitId, count));
}
```

`sendReleaseStaffAlert`: admin read of `visits` (`id, visit_number, is_sample, deleted_at, patients ( first_name, last_name )`, `.eq("id", visitId).is("deleted_at", null).maybeSingle()` — a LIVE read at query level (rev 5: the callback runs after the response, so the caller's earlier check is not enough); `{ error }` → `reportError` and return; no row → audit skipped "visit deleted or missing" and return. Register it in `query-surfaces.test.ts` `LIFECYCLES` as live (the `.is("deleted_at", null)` satisfies the guard at ~L1020/L1227) and classify the embedded `patients` read per the patients-inventory test (a history read of the visit's own patient — no active filter: the release already refused an inactive patient); skip sample; resolve recipients; build; send sequentially; one audit row; catch-all → `reportError({ scope: "notify/result-released-staff-alert", … })`. Register the file in whichever inventory the guards require (`query-surfaces` `LIFECYCLES` for the `visits` read — "spans deleted" is wrong here, use the live declaration with the reason "caller proved the visit live"; `patient-senders.test.ts` if it scans staff senders — it documents that staff alerts are covered there).
- [ ] **Step 10: Wire it.** In `releaseVisitSelection` (the path every queue and visit-page release goes through), after notifying: `scheduleReleaseStaffAlert(visitId, out.announced.length)`.
  **Second release path (Codex rev 5 P1):** `src/lib/actions/results/finalise-consolidated.ts` step 9 (~L461) releases a finalised chemistry report itself when the visit is settled and nothing needs sign-off. After its `result.released` audit (~L515), schedule the alert only when the whole report went out in that write: `if (!releaseDeferred && (releasedRows ?? []).length === input.testRequestIds.length && input.testRequestIds.length > 0) scheduleReleaseStaffAlert(input.visitId, releasedRows!.length);` — a payment/consent deferral or a sign-off partial sends nothing now (the later release from the queue or visit page goes through `releaseVisitSelection` and alerts then); a repeated finalisation matches no `ready_for_release` rows (`releasedRows` empty → `releaseDeferred`), so it cannot alert twice. Do not otherwise change finalisation (it still sends no patient notice — pre-existing, surfaced as a follow-up). Tests in the existing finalise test file (or a new `finalise-consolidated-alert.test.ts` if none exists; mock `@/lib/notifications/release-staff-alert`): complete → one call with the released count; payment-deferred (23514 payment) → none; sign-off partial (fewer rows than ids) → none; second finalisation (0 rows) → none.
  Nothing else calls it (the admin package-header release and "Mark done" are not lab result releases). Grep `status: "released"` across `src/` (non-test) at the end and confirm every hit is one of: `release-rows.ts`, `finalise-consolidated.ts`, `releasePackageHeaderAction`, mark-done. Extend the Task 8 helper tests and Task 18 action tests (already listed there) to assert one scheduled alert per visit with the announced count, and none for a refused/incomplete report.
- [ ] **Step 11:** `npm test && npm run typecheck && npm run lint`; `npm run db:types` (expect no diff). **Commit** `feat(alerts): email reception when results are released (0192)`.
- [ ] **Prod (right before merge, not during the build):** from this worktree rebased on current `origin/main`, with `supabase/.temp/{project-ref,linked-project.json,pooler-url}` copied in: MCP `list_migrations` to confirm 0192 is free on prod and whether 0191 (#254) is applied; `supabase db push --dry-run` (add `--include-all` only if 0191 is still unapplied and genuinely must go first — it must NOT: 0191 is #254's; if 0191 is unapplied, the dry-run must list ONLY 0192, else stop); push; verify by object: `select pg_get_constraintdef(oid) from pg_constraint where conname = 'staff_alert_settings_key_check'` contains `result_released`, and `select enabled from staff_alert_settings where alert_key = 'result_released'` → `true`. The app must not deploy before this (the CHECK would reject the new key's settings writes and the resolver would fail open to defaults).
- **Rollback (rev 5):** reverting the app leaves 0192 installed — harmless (an unused key and settings row; subscriptions kept). To stop the emails without a deploy, switch "Results released" off in Admin Tools › Email Alerts. Never narrow the CHECK back while the `result_released` row exists (it would fail); a real down-migration must delete the settings/recipient rows first.

---

### Task 17 additions (rev 4) — local checks for Tasks 18–20

11. **Visit page, whole report (View as Medical Tech):** a chemistry report with two ready members → each row reads "Release report (2 tests)"; clicking one releases both; notice says "Also released 1 other test on the same combined report."; the portal shows the PDF. Mixed report (one member `result_uploaded`) → both rows show the "isn't finished" reason, no checkbox, button disabled; a forged `releaseTestAction` call on the ready member returns the same refusal and releases nothing. Package "Release all ready" with a component on a mixed report → the others release, the refused one is named in the notice.
12. **Visit page bulk:** select one member of a two-member ready report + a plain row → the violet preview says it also releases 1 other test; outcome counts right.
13. **Admin dashboard (as admin, not View-as):** "Ready for release" count equals the Pending release tab's total as admin; put one ready result on an unpaid visit → hint "1 waiting on payment"; the card is hideable in dashboard settings.
14. **Email alert:** with `NOTIFICATIONS_LIVE` unset locally, release as medtech → one `test_request.released.staff_alert_sent` audit row per visit per release action with `skipped` = the email-skipped reason and `count` right; a bulk release across two visits → two rows; a sample visit → `skipped: "sample visit"`; a refused mixed report → no row. Admin Tools › Email Alerts lists "Results released" with reception on by default; turning it off → next release audits `skipped: "turned off in Email Alerts"`. Read one built email (log `buildReleaseAlertEmail` output in a scratch test) — no surname, no test names. Finalise a paid chemistry report with no sign-off → one alert audit row; finalise one needing sign-off → none until it is released later.

### Task 16 additions (rev 4)

- Guide: visit page — "Releasing one test on a combined report (for example a chemistry panel) now releases every finished test on that report together; if any test on it is still waiting for a result or sign-off, the report can't be released yet and the page says why." (call it out as a change in the "What's new" / changelog block the guide keeps).
- Guide: admin dashboard "Ready for release" card and its "waiting on payment" hint; Admin Tools › Email Alerts gains "Results released" (reception by default; name + visit # + count only).
- PR body: a **Behaviour change** section for Task 18 and a **Migration 0192** section (push order: right before merge).

## Skills to update in the same PR

`drmed-result-templates` and `drmed-payments` (`.claude/skills/`, git-tracked) cite the release flow and `visits/[id]/undo-release-dialog.tsx`; update their paths (dialog moved to `src/components/staff/release/`, release write now `src/lib/actions/visits/release-rows.ts`) and add "the lab releases from the queue; a combined report releases whole or not at all".

## Revision log

- **rev 2 (Codex Astra high review, 2026-09-28):** P1 whole-report release could release part of a mixed report → added `planReportRelease` (full membership incl. status/deleted/doctor), completeness check + withheld notice; P2 reread attribution → `releaseRows` core returns RETURNING ids; P2 panels not bulk-selectable → panel selection entries with weight + flattening; P2 consolidated page lacked lifecycle selects/types → specified; P2 typed revalidation missed route groups → `/(staff)/staff/(dashboard)/queue` + untyped `/staff`; P3 bell identity (event key + unique item ids), shared DB/app refusal wording (`release-messages.ts`), delivery copy corrected; added validation cases (forged calls, consent withdrawal, waived/HMO, inactive, limits, Manila midnight) and a rollback note.
- **rev 3 (Codex recheck, 2026-09-28 — no third Codex round, per the review rule):** P1 fail-closed membership reads before the write, and a post-write verification that requires the full known membership (else no notice + warning); completeness described as observed-at-that-moment. P2 outcome notice moved to a page-level `ReleaseOutcomeProvider` (Task 9a) that survives the refresh and includes "Also released…". P2 guard integration: core moved to `src/lib/actions/visits/release-rows.ts` (write-guards scanner coverage), self-guards the active patient, registered in `SURFACES`/`LIFECYCLES`; dropped the inapplicable `DERIVED_ROW_SETS` exemption. P3 rollback note: sent notices / viewed copies can't be recalled. Added fail-closed and same-user-concurrency tests; skills-update step.
- **rev 4 (2026-09-30, owner scope):** Tasks 18–20 expanded to full TDD steps; Task 8's per-visit pipeline becomes the shared `releaseVisitSelection` helper (visit page + queue); `releaseOutcomeText` takes counts; staff release email carries first name + last initial, visit # and a count only (owner privacy decision); migration 0192 claimed; build order puts Task 13 last because open PR #254 rewrites the queue list.
- **rev 5 (Codex Astra high on the addendum, 2026-09-30):** P1 consolidated finalisation releases outside `releaseVisitSelection` → it now schedules the staff alert when the whole report went out; P2 visit actions report a write whenever either changed list is non-empty (inverse-race case); P2 new `VisitReleaseResult`/`VisitBulkReleaseResult` types, existing `ReleaseResult`/`BulkSelectionResult` untouched; P2 package action returns `changedCount`; P2 alert sender reads the visit live at query level and handles `{error}`/missing; P3 rollback note; email links to the visit page (not Released today, which empties at Manila midnight).
