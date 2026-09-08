# Flow-review PR 3 — Medium Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four medium-cost gaps from the 2026-09-02 flow review: server-side section scoping on the two single-row release actions, self-service unclaim for the staff member who holds a claim, an RA 10173 consent row for genuinely new `/schedule` registrants, and an audited CSV export on all seven admin report pages.

**Architecture:** Items 1–3 are surgical edits to existing Server Actions that reuse the pure helpers already in the tree (`scopeToAllowedSections`, the admin unclaim's shape, `/register`'s consent grant). Item 4 extracts each report's inline query into a loader module under `src/lib/reports/` that is shared by the page and a new `/api/admin/reports/<name>.csv` Route Handler — the same page-and-export-share-one-query pattern `src/lib/visits/archive-query.ts` + `/api/admin/visits.csv` already use — so a CSV can never export a different row set than the table above the button. Routes run under the RLS-scoped server client with `requireAdminStaff`, a hard row ceiling, and a `report.<name>.exported` audit row.

**Tech Stack:** Next.js 16 (App Router, RSC + Server Actions + Route Handlers), Supabase (Postgres, RLS, PostgREST via supabase-js), vitest. No migration in this PR — prod stays at 0133.

**Worktree/branch:** `~/Claude/DRMed/.worktrees/flow-review-fixes`, branch `pr3/medium-fixes` (already created off `origin/main` @ `003c0eb`). `node_modules` is a symlink to the main checkout; `.env.local` + `supabase/.temp` are in place.

**Baseline (after PR 2):** `npm test` 910 passed · `npm run typecheck` clean · `npm run lint` 0 errors + 2 pre-existing warnings (`admin-dashboard.tsx` `PlannedCard`, `validations/booking.ts:97` `serviceIds`).

---

## Ground rules (learned in PRs 1–2 — read before touching anything)

1. **Every staff page lives under the invisible route group `(dashboard)`**: `src/app/(staff)/staff/(dashboard)/<x>` serves `/staff/<x>`. Paths below are written in full. `/staff/mfa` is the one exception and is not touched here.
2. **Every export of a `"use server"` file is a publicly callable endpoint** whether or not any client references it. A new action helper must re-prove its own arguments (ownership, section, status) in its own WHERE clause — never trust the caller or the page that rendered the button.
3. **When this PR extracts something shared, grep the WHOLE tree** for the thing it replaces (per-agent file ownership hides siblings). Each task below lists its grep.
4. **`sectionsForRole(role) === []` is a deny, `null` is unrestricted.** Never treat `[]` as "no filter".
5. **Exports run under the RLS-scoped server client (`createClient()` from `@/lib/supabase/server`)**, never the service-role client — an export must not return a row the exporting admin could not already read. Verified on prod 2026-09-08: the admin JWT has SELECT on `audit_log` (`admin select` policy), `staff_advances` (`admin all`), `staff_profiles`, `patients`, `visits`, `test_requests`, `services`, and on both 0043 views (`v_daily_revenue_by_service`, `v_staff_advances_outstanding` are owner-`postgres` views with the default `authenticated` SELECT grant).
6. **Dates:** DB is UTC, clinic is Asia/Manila. Filters on `timestamptz` columns use the half-open window from `manilaRangeUtc(start, end)` → `gte(fromIso)` + `lt(toIso)`. Plain `date` columns (`business_date`, `visit_date`) compare as strings.
7. **PostgREST caps one response at 1000 rows.** Anything that can exceed that walks with `.range()` under a **total order** (add an `id` tie-break). `.in()` lists ride in the query string — chunk them.
8. **Every read of `visits` / `test_requests` filters `deleted_at is null`** unless the surface is specifically about deleted rows.
9. **Vitest covers pure logic only.** Modules under test must not `import "server-only"` (type-only imports from server modules are fine — they are erased). Server Actions and Route Handlers are verified by `npm run typecheck` + review, not vitest — that is the repo convention, not a shortcut.
10. **No `any`** without a comment. Conventional Commits. Do not touch `booking-form.tsx`, `src/lib/accounting/mappers.ts`, the admin `ReassignPanel`, or `/api/admin/visits.csv`'s behaviour.

**Verification commands (run from the worktree root):**

```bash
npm test                      # expect 910 + new tests passing
npm run typecheck             # expect clean
npm run lint                  # expect 0 errors, 2 pre-existing warnings
npx vitest run <file>         # single file
```

---

## File map

| File | Action | Responsibility |
|---|---|---|
| **Item 1 — section scoping** | | |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` | Modify | `releaseTestAction` + `markDoctorLineDoneAction` pre-read the row with its service section and pass it through `scopeToAllowedSections` |
| `src/lib/auth/role-sections.test.ts` | Create | Pins the role→section contract and the "doctor lines survive only for admin/pathologist" invariant |
| **Item 2 — self-service unclaim** | | |
| `src/app/(staff)/staff/(dashboard)/queue/actions.ts` | Modify | Shared private `performUnclaim`; `unclaimTestAction` (admin) delegates; new `unclaimOwnTestAction` (owner only) |
| `src/app/(staff)/staff/(dashboard)/queue/[id]/unclaim-own-button.tsx` | Create | Client confirm + optional reason, mirrors the admin panel's Unclaim block |
| `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx` | Modify | Render the button for the holder when not admin |
| **Item 3 — /schedule consent** | | |
| `src/lib/consent/self-registration.ts` | Create | Pure: `selfRegistrationGrant()` row builder + `shouldRecordBookingConsent()` |
| `src/lib/consent/self-registration.test.ts` | Create | Unit tests |
| `src/app/(marketing)/schedule/actions.ts` | Modify | Insert the grant for a `created` patient only; audit `consent_recorded` |
| `src/app/(marketing)/register/actions.ts` | Modify | Use the shared row builder (whole-tree adoption) |
| **Item 4 — shared export pieces** | | |
| `src/lib/reports/paging.ts` + `.test.ts` | Create | `PAGE_SIZE`, `IN_CHUNK`, `REPORT_EXPORT_MAX_ROWS`, `chunk`, `unique`, `fetchAllRows` |
| `src/lib/reports/format.ts` + `.test.ts` | Create | `csvManilaStamp`, `pluckOne` (one copy replaces four private ones) |
| `src/lib/reports/csv-response.ts` | Create | server-only: audit row + CSV `NextResponse` |
| `src/components/staff/export-csv-link.tsx` | Create | The one "Export CSV" anchor |
| `src/app/(staff)/staff/(dashboard)/visits/page.tsx` | Modify | Adopt `ExportCsvLink` (byte-identical class string, zero visual change) |
| **Item 4 — one loader + route per report** | | |
| `src/lib/reports/daily-revenue.ts` + `.test.ts` | Create | params, loader, `groupByDate`, CSV rows, href, filename |
| `src/lib/reports/staff-advances.ts` + `.test.ts` | Create | same shape |
| `src/lib/reports/patients-without-consent.ts` + `.test.ts` | Create | same shape |
| `src/lib/reports/deleted-entries.ts` + `.test.ts` | Create | same shape + `deriveDeletedEntry` |
| `src/lib/reports/undone-releases.ts` + `.test.ts` | Create | same shape + `deriveUndoneRelease` |
| `src/lib/reports/lab-tat.ts` + `.test.ts` | Create | same shape + `aggregateLabTat`, `median`, `percentile`, `SECTION_LABEL` |
| `src/lib/reports/stuck-tests.ts` + `.test.ts` | Create | same shape + `ageDays` |
| `src/app/api/admin/reports/<name>.csv/route.ts` ×7 | Create | admin gate → RLS client → loader → `reportCsvResponse` |
| `src/app/(staff)/staff/(dashboard)/admin/reports/<name>/page.tsx` ×7 | Modify | Replace inline query with the loader; add `ExportCsvLink`; show the truncation notice |

**Task dependencies:** Tasks 1, 2, 3 and 4 are independent of each other (disjoint files) — run them in parallel. Tasks 5–11 each depend on Task 4 only and are mutually independent — run them in parallel after Task 4 lands. Task 12 runs last.

---

## Task 1: Section-scope `releaseTestAction` and `markDoctorLineDoneAction`

**Why:** `releaseSelectedAction` already pre-reads its candidates with `services!inner ( section, name )` and narrows them with `scopeToAllowedSections(rows, sectionsForRole(role))`. The two single-row actions skip that: `releaseTestAction` releases any `ready_for_release` row on the visit, and `markDoctorLineDoneAction` checks only the service *kind*. RLS on `test_requests` is role-only, not section-aware (0023), so today a medtech who replays the action with another section's id — or a doctor line's id — succeeds. Doctor-consultation/procedure services carry `section = NULL` in the DB; `scopeToAllowedSections` passes a null-section row only when the allow-list is `null` (admin/pathologist), which is exactly the "doctor lines stay admin/pathologist-only" rule the visit page already applies at render time.

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` (`releaseTestAction` ≈ lines 53–116, `markDoctorLineDoneAction` ≈ lines 587–649)
- Create: `src/lib/auth/role-sections.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/auth/role-sections.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, sectionsForRole } from "./role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";

const ROLES = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
] as const;

describe("sectionsForRole", () => {
  it("denies reception outright — [] is 'no access', never 'no filter'", () => {
    expect(sectionsForRole("reception")).toEqual([]);
  });

  it("is unrestricted (null) for admin and pathologist only", () => {
    expect(sectionsForRole("admin")).toBeNull();
    expect(sectionsForRole("pathologist")).toBeNull();
    expect(sectionsForRole("medtech")).not.toBeNull();
    expect(sectionsForRole("xray_technician")).not.toBeNull();
  });

  it("splits the bench: medtech gets the lab sections, xray gets imaging, no overlap", () => {
    const medtech = sectionsForRole("medtech") ?? [];
    const xray = sectionsForRole("xray_technician") ?? [];
    expect(medtech).toEqual([
      "chemistry",
      "hematology",
      "immunology",
      "urinalysis",
      "microbiology",
      "send_out",
    ]);
    expect(xray).toEqual(["imaging_xray", "imaging_ultrasound", "imaging_ecg"]);
    expect(medtech.filter((s) => xray.includes(s))).toEqual([]);
  });

  it("never hands a doctor section to a restricted role", () => {
    for (const role of ["medtech", "xray_technician", "reception"] as const) {
      const list = sectionsForRole(role) ?? [];
      expect(list).not.toContain("consultation");
      expect(list).not.toContain("procedure");
    }
  });

  it("only lists sections that exist", () => {
    for (const role of ROLES) {
      for (const s of sectionsForRole(role) ?? []) {
        expect(ALL_SECTIONS).toContain(s);
      }
    }
  });
});

// The invariant releaseTestAction / markDoctorLineDoneAction rely on: doctor
// lines carry section = NULL in the DB, and a null-section row survives
// scoping only under an unrestricted (null) list.
describe("doctor lines (section null) through scopeToAllowedSections", () => {
  const doctorLine = {
    id: "consult-1",
    services: { section: null, name: "Consultation" },
  };

  it.each(ROLES)("%s", (role) => {
    const passes =
      scopeToAllowedSections([doctorLine], sectionsForRole(role)).length === 1;
    expect(passes).toBe(role === "admin" || role === "pathologist");
  });

  it("a chemistry line passes for medtech, admin, pathologist and nobody else", () => {
    const chem = { id: "fbs-1", services: { section: "chemistry", name: "FBS" } };
    const passing = ROLES.filter(
      (role) => scopeToAllowedSections([chem], sectionsForRole(role)).length === 1,
    );
    expect(passing).toEqual(["medtech", "pathologist", "admin"]);
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/lib/auth/role-sections.test.ts`. Expected: PASS already (it pins existing behaviour; that is the point — the two actions below are wired to this invariant). If it fails, the contract drifted — stop and report.

- [ ] **Step 3: Rewrite `releaseTestAction`.** `sectionsForRole` and `scopeToAllowedSections` are already imported at the top of the file. Replace the function body from `const session = await requireActiveStaff();` up to (not including) `const { data: updated, error } = await supabase` with:

```ts
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // Section gate, server-side (mirrors releaseSelectedAction). RLS on
  // test_requests is role-only, not section-aware (0023), so the action has to
  // prove the row sits in a section this role may release. Doctor lines carry
  // a null section and therefore survive only for admin/pathologist (null =
  // unrestricted) — see scopeToAllowedSections.
  const allowedSections = sectionsForRole(session.role);
  const { data: candidate } = await supabase
    .from("test_requests")
    .select("id, services!inner ( section, name )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .eq("status", "ready_for_release")
    .maybeSingle();
  if (!candidate) {
    revalidatePath(`/staff/visits/${visitId}`);
    return { ok: false, error: "This result is no longer ready to release." };
  }
  if (scopeToAllowedSections([candidate], allowedSections).length === 0) {
    return {
      ok: false,
      error: "This test is outside the sections you can release.",
    };
  }

  const now = new Date().toISOString();
```

Everything from `const { data: updated, error } = await supabase` onward is unchanged (the UPDATE still re-applies `.eq("status", "ready_for_release")`, so a concurrent release still yields the existing "no longer ready" branch).

- [ ] **Step 4: Rewrite the pre-read in `markDoctorLineDoneAction`.** Replace:

```ts
  // Guard server-side so a future/mis-wired caller can't release another kind.
  const { data: tr } = await supabase
    .from("test_requests")
    .select("services ( kind )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .maybeSingle();
  const svc = Array.isArray(tr?.services) ? tr?.services[0] : tr?.services;
  if (!tr || svc?.kind !== expectedKind) {
    return { ok: false, error: wrongKindError };
  }
```

with:

```ts
  // Guard server-side so a future/mis-wired caller can't release another kind.
  const { data: tr } = await supabase
    .from("test_requests")
    .select("id, services!inner ( kind, section, name )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .maybeSingle();
  const svc = Array.isArray(tr?.services) ? tr?.services[0] : tr?.services;
  if (!tr || svc?.kind !== expectedKind) {
    return { ok: false, error: wrongKindError };
  }

  // Doctor lines are admin/pathologist-only. Their services carry a null
  // section, which scopeToAllowedSections passes only for an unrestricted
  // (null) role list — the same rule that hides them from medtech, xray and
  // reception on the visit page. Enforced here because every export of this
  // "use server" module is a callable endpoint.
  if (scopeToAllowedSections([tr], sectionsForRole(session.role)).length === 0) {
    return {
      ok: false,
      error:
        "Only an admin or pathologist can mark a consultation or procedure done.",
    };
  }
```

- [ ] **Step 5: Typecheck + tests** — `npm run typecheck && npx vitest run src/lib/auth src/lib/visits`. Expected: clean, all passing. If `candidate`/`tr` don't satisfy `SelectableRow`, the `services` embed type is the culprit — `SelectableRow.services` accepts object, array or null; make sure `id` is in the select.

- [ ] **Step 6: Whole-tree grep** — `grep -rn "releaseTestAction\|markConsultationDoneAction\|markProcedureDoneAction" src` — expected callers: `release-button.tsx` and `mark-done-button.tsx` only. No caller changes needed (the page already hides both buttons for out-of-section rows; the change is the server-side backstop).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts" src/lib/auth/role-sections.test.ts
git commit -m "fix(visits): section-scope single-row release and mark-done actions server-side"
```

---

## Task 2: Self-service unclaim for the claim holder

**Why:** Only admin can unclaim today (`unclaimTestAction` → `requireAdminStaff`). A medtech who claimed the wrong test, or is going off shift, has no way to hand it back. The claim is modelled entirely by `test_requests.assigned_to` + `status = 'in_progress'` (no claim table). RLS's medtech UPDATE policy is role-scoped, not row-scoped, so **ownership must be proven in the action's WHERE clause** — the same way `claimTestAction` proves `status = 'requested'`.

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/queue/[id]/unclaim-own-button.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx`

- [ ] **Step 1: Share the unclaim core.** In `queue/actions.ts` change the `require-staff` import to also bring the session type:

```ts
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
```

Then replace the whole existing `unclaimTestAction` (from `export async function unclaimTestAction(` through its closing `}`; it sits right after the `LAB_CAPABLE_ROLES` constant) with:

```ts
// Shared by the admin unclaim (any holder) and the self-service unclaim (own
// claim only). `ownerId` narrows the UPDATE to rows the caller holds — RLS on
// test_requests is role-scoped, not row-scoped (0023), so ownership has to be
// proven here, in the WHERE clause, the same way claimTestAction proves
// `status = 'requested'`.
async function performUnclaim(
  session: StaffSession,
  testRequestId: string,
  reason: string | undefined,
  ownerId: string | null,
): Promise<ClaimResult> {
  const supabase = await createClient();

  // Pre-read the current holder for the audit row — the post-update select
  // would return assigned_to already nulled.
  const { data: before } = await supabase
    .from("test_requests")
    .select("assigned_to")
    .eq("id", testRequestId)
    .maybeSingle();

  // Only an in-flight claim with no uploaded result can be unclaimed. A
  // queue-deleted line (0125) is refused even via a stale link — same rule as
  // claim and reassign.
  let update = supabase
    .from("test_requests")
    .update({ status: "requested", assigned_to: null, started_at: null })
    .eq("id", testRequestId)
    .eq("status", "in_progress")
    .not("assigned_to", "is", null)
    .is("deleted_at", null);
  if (ownerId !== null) update = update.eq("assigned_to", ownerId);
  const { data, error } = await update.select("id, visit_id").maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) {
    return {
      ok: false,
      error:
        ownerId === null
          ? "Only claimed, in-progress tests can be unclaimed."
          : "You can only unclaim a test you currently hold that has no result yet.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.unclaimed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: data.visit_id,
      previous_assignee: before?.assigned_to ?? null,
      reason: reason?.trim() || null,
      self_service: ownerId !== null,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true };
}

// Admin: hand ANY stuck claim back to the queue (the ReassignPanel's Unclaim).
export async function unclaimTestAction(
  testRequestId: string,
  reason?: string,
): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  return performUnclaim(session, testRequestId, reason, null);
}

// Self-service: a lab worker hands their OWN claim back (wrong section, end of
// shift, sample problem). Ownership is the gate, not role — anyone who can hold
// a claim can release it. Audited like the admin path, flagged `self_service`
// so the two stay distinguishable in the log.
export async function unclaimOwnTestAction(
  testRequestId: string,
  reason?: string,
): Promise<ClaimResult> {
  const session = await requireActiveStaff();
  if (!(LAB_CAPABLE_ROLES as readonly string[]).includes(session.role)) {
    return { ok: false, error: "Only lab staff can unclaim a test." };
  }
  return performUnclaim(session, testRequestId, reason, session.user_id);
}
```

Note the one behaviour change to the admin path: `.is("deleted_at", null)` — the `drmed-result-templates` skill already documents unclaim as refusing soft-deleted lines; `reassignTestAction` filters it; `unclaimTestAction` did not. This closes that parity gap. `reassignTestAction` and the `ReassignPanel` component are untouched.

- [ ] **Step 2: Create the button** — `src/app/(staff)/staff/(dashboard)/queue/[id]/unclaim-own-button.tsx`

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unclaimOwnTestAction } from "../actions";

// Self-service counterpart of the admin ReassignPanel's Unclaim: lets the staff
// member who holds this claim hand it back to the queue. Same confirm +
// optional-reason shape so the two read as one feature.
export function UnclaimOwnButton({ testRequestId }: { testRequestId: string }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onUnclaim() {
    startTransition(async () => {
      setErr(null);
      const result = await unclaimOwnTestAction(testRequestId, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setConfirmOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3 text-xs">
      <p className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Your claim
      </p>

      {!confirmOpen ? (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          Unclaim — put it back in the queue
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2">
          <p className="text-[color:var(--color-brand-text-mid)]">
            Unclaiming puts this test back in the queue for anyone in the
            section to claim. Only possible while no result has been uploaded.
            The action is audit-logged.
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)…"
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onUnclaim}
              disabled={pending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {pending ? "Unclaiming…" : "Confirm unclaim"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                setReason("");
                setErr(null);
              }}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {err ? <p className="text-red-600">{err}</p> : null}
    </div>
  );
}
```

- [ ] **Step 3: Render it on the detail page** — `queue/[id]/page.tsx`. Add the import next to `ReassignPanel`:

```ts
import { UnclaimOwnButton } from "./unclaim-own-button";
```

Right after the line `const showReassignPanel = session.role === "admin" && !!test.assigned_to;` add:

```ts
  // Self-service unclaim for the holder. Admin gets the ReassignPanel (which
  // already has Unclaim) instead, so the two never render together. The
  // Server Action re-proves ownership + status; this is UX, not the guard.
  const showSelfUnclaim =
    !showReassignPanel && ownedByMe && test.status === "in_progress";
```

(`ownedByMe` is already defined above — `test.assigned_to === user?.id`.) Then directly after the `{showReassignPanel ? (<ReassignPanel … />) : null}` block add:

```tsx
          {showSelfUnclaim ? (
            <UnclaimOwnButton testRequestId={test.id} />
          ) : null}
```

- [ ] **Step 4: Typecheck + lint** — `npm run typecheck && npm run lint`. Expected: clean. The `let update = …; update = update.eq(…)` reassignment typechecks because the filter builder's `.eq()` returns `this`.

- [ ] **Step 5: Whole-tree grep** — `grep -rn "unclaimTestAction\|test_request.unclaimed" src docs/drmed-user-guide.html .claude/skills`. Expected code callers: `reassign-panel.tsx` only (unchanged). The user guide line `<dt>Self-service unclaim</dt><dd>Only Admin can unclaim or reassign a test.</dd>` and the ch. 8 limitations list are **PR 4's** to update — do not edit docs here; note it in the PR body.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/queue/actions.ts" "src/app/(staff)/staff/(dashboard)/queue/[id]/unclaim-own-button.tsx" "src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx"
git commit -m "feat(queue): let the claim holder unclaim their own test, audited"
```

---

## Task 3: `/schedule` service agreement → consent row for a genuinely new patient

**Why:** The public booking form's required "Service agreement" tick is validated (`service_agreement` refines to `true` in both `BookingSchema` and `ExistingPatientBookingSchema`) but never written anywhere — `schedule/actions.ts` has zero `patient_consents` references. `/register` records a `self_registration` grant for a **new** registrant only and never on a dedup match ("a public form must not re-affirm an existing patient's consent"). `/schedule` already knows which case it is: `result.patient.resolution` is `"created"` only when `resolvePatient`'s guarded RPC inserted a fresh row; `"reused"` (dedup), `"existing"` (patient picked/portal) and `"walk_in"` must never write. Method stays `self_registration` — no CHECK widening, no migration.

**Files:**
- Create: `src/lib/consent/self-registration.ts`, `src/lib/consent/self-registration.test.ts`
- Modify: `src/app/(marketing)/schedule/actions.ts`, `src/app/(marketing)/register/actions.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/consent/self-registration.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { CURRENT_CONSENT_NOTICE_VERSION } from "./notice";
import {
  selfRegistrationGrant,
  shouldRecordBookingConsent,
} from "./self-registration";

describe("shouldRecordBookingConsent", () => {
  it("records for a brand-new patient who ticked the agreement", () => {
    expect(shouldRecordBookingConsent("created", true)).toBe(true);
  });

  it.each(["reused", "existing", "walk_in"] as const)(
    "never re-affirms consent for a %s patient from a public form",
    (resolution) => {
      expect(shouldRecordBookingConsent(resolution, true)).toBe(false);
    },
  );

  it("never records without the tick, even for a new patient", () => {
    expect(shouldRecordBookingConsent("created", false)).toBe(false);
  });
});

describe("selfRegistrationGrant", () => {
  const row = selfRegistrationGrant({
    patientId: "p-1",
    ip: "203.0.113.9",
    userAgent: "vitest",
  });

  it("is a patient-actor 'granted' event with the current notice version", () => {
    expect(row).toEqual({
      patient_id: "p-1",
      event_type: "granted",
      method: "self_registration",
      notice_version: CURRENT_CONSENT_NOTICE_VERSION,
      signatory: "self",
      actor_kind: "patient",
      ip: "203.0.113.9",
      user_agent: "vitest",
    });
  });

  it("never sets created_by — no staff member vouched for a self-service grant", () => {
    expect("created_by" in row).toBe(false);
  });

  it("passes null ip/agent through unchanged", () => {
    const anon = selfRegistrationGrant({ patientId: "p-2", ip: null, userAgent: null });
    expect(anon.ip).toBeNull();
    expect(anon.user_agent).toBeNull();
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/lib/consent/self-registration.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Create the module** — `src/lib/consent/self-registration.ts`

```ts
import type { Database } from "@/types/database";
import type { PatientResolution } from "@/lib/appointments/create";
import { CURRENT_CONSENT_NOTICE_VERSION } from "./notice";

type ConsentInsert = Database["public"]["Tables"]["patient_consents"]["Insert"];

/**
 * The one shape of a public self-service consent grant — written by /register
 * and, for a brand-new patient only, by /schedule. actor_kind 'patient' and no
 * created_by: the patient granted it themselves; no staff member vouched.
 *
 * Pure (no server-only) so the row shape is unit-tested and both public forms
 * cannot drift apart.
 */
export function selfRegistrationGrant(input: {
  patientId: string;
  ip: string | null;
  userAgent: string | null;
}): ConsentInsert {
  return {
    patient_id: input.patientId,
    event_type: "granted",
    method: "self_registration",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: "self",
    actor_kind: "patient",
    ip: input.ip,
    user_agent: input.userAgent,
  };
}

/**
 * A public booking form may record consent ONLY for a patient it just created.
 * A dedup match ("reused"), an existing/portal patient or a walk-in must never
 * have their consent state re-affirmed from a public form — otherwise anyone
 * who knows a patient's email + surname + birthdate could "consent" for them.
 */
export function shouldRecordBookingConsent(
  resolution: PatientResolution["resolution"],
  serviceAgreement: boolean,
): boolean {
  return resolution === "created" && serviceAgreement === true;
}
```

- [ ] **Step 4: Run the test** — expected PASS. (`create.ts` is imported type-only, so its `node:crypto` import never loads under vitest.)

- [ ] **Step 5: Wire `/schedule`.** In `src/app/(marketing)/schedule/actions.ts` add the import:

```ts
import { selfRegistrationGrant, shouldRecordBookingConsent } from "@/lib/consent/self-registration";
```

Immediately after the block

```ts
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
```

insert:

```ts
  // RA 10173: the required "Service agreement" tick is a consent grant, but
  // only for a patient this booking CREATED. A dedup match, an existing
  // patient or a portal booking never gets its consent re-affirmed from a
  // public form — same rule as /register. The sync_patient_consent_state
  // trigger flips patients.consent_current on insert.
  let consentRecorded = false;
  if (
    result.patient.patientId &&
    shouldRecordBookingConsent(result.patient.resolution, data.service_agreement)
  ) {
    const { error: consentError } = await admin
      .from("patient_consents")
      .insert(
        selfRegistrationGrant({
          patientId: result.patient.patientId,
          ip: requestIp,
          userAgent,
        }),
      );
    if (consentError) {
      // The booking exists — don't fail it. Surface the gap so staff can
      // capture consent at the counter instead.
      await reportError({
        scope: "schedule/consent-grant",
        error: new Error(consentError.message),
        metadata: {
          patient_id: result.patient.patientId,
          booking_group_id: result.bookingGroupId,
        },
      });
    } else {
      consentRecorded = true;
    }
  }
```

Then in the `appointment.booked` audit call's `metadata`, add one key after `patient_resolution: result.patient.resolution,`:

```ts
      consent_recorded: consentRecorded,
```

`data.service_agreement` is a `boolean` on both parsed shapes (zod transforms `"on"` → `true`).

- [ ] **Step 6: Adopt the builder in `/register`** (whole-tree rule). In `src/app/(marketing)/register/actions.ts` replace

```ts
  await admin.from("patient_consents").insert({
    patient_id: res.id,
    event_type: "granted",
    method: "self_registration",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: "self",
    actor_kind: "patient",
    ip,
    user_agent: ua,
  });
```

with

```ts
  await admin
    .from("patient_consents")
    .insert(selfRegistrationGrant({ patientId: res.id, ip, userAgent: ua }));
```

and swap the import `import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";` for `import { selfRegistrationGrant } from "@/lib/consent/self-registration";` (that constant has no other use in the file — verify with `grep -c CURRENT_CONSENT_NOTICE_VERSION "src/app/(marketing)/register/actions.ts"` → `0` after the edit).

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/consent`. Expected clean. Whole-tree grep: `grep -rn "method: \"self_registration\"" src` → only `self-registration.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/consent/self-registration.ts src/lib/consent/self-registration.test.ts "src/app/(marketing)/schedule/actions.ts" "src/app/(marketing)/register/actions.ts"
git commit -m "feat(schedule): record RA 10173 consent for a newly created booking patient only"
```

---

## Task 4: Shared export pieces (paging, format, CSV response, the link)

**Why:** Seven routes need the same four things: a way to walk past PostgREST's 1000-row cap with an exact "truncated" flag, chunked `.in()` lookups, one audit-and-respond helper, and one "Export CSV" anchor. The visits page currently inlines its anchor; the four audit/lab reports each carry a private `pluckOne`. This task creates the shared copies and adopts them where they already exist.

**Files:**
- Create: `src/lib/reports/paging.ts`, `src/lib/reports/paging.test.ts`, `src/lib/reports/format.ts`, `src/lib/reports/format.test.ts`, `src/lib/reports/csv-response.ts`, `src/components/staff/export-csv-link.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/page.tsx` (≈ lines 199–206)

- [ ] **Step 1: Failing tests** — `src/lib/reports/paging.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  fetchAllRows,
  PAGE_SIZE,
  REPORT_EXPORT_MAX_ROWS,
  unique,
} from "./paging";

// A fake PostgREST: `.range(from, to)` over an in-memory array, capped at
// PAGE_SIZE per call exactly like the real thing.
function fakeSource(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: all.slice(from, Math.min(to + 1, from + PAGE_SIZE)), error: null };
  });
  return { fetchPage, calls };
}

describe("fetchAllRows", () => {
  it("returns everything in one call when the set is small", async () => {
    const { fetchPage, calls } = fakeSource(7);
    const out = await fetchAllRows(fetchPage, 500);
    expect(out.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.truncated).toBe(false);
    expect(calls).toEqual([[0, 500]]);
  });

  it("walks page by page past the 1000-row cap", async () => {
    const { fetchPage, calls } = fakeSource(2500);
    const out = await fetchAllRows(fetchPage, REPORT_EXPORT_MAX_ROWS);
    expect(out.rows).toHaveLength(2500);
    expect(out.truncated).toBe(false);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("is not truncated when the set is exactly the ceiling", async () => {
    const { fetchPage } = fakeSource(300);
    const out = await fetchAllRows(fetchPage, 300);
    expect(out.rows).toHaveLength(300);
    expect(out.truncated).toBe(false);
  });

  it("flags truncation and trims to the ceiling when there is more", async () => {
    const { fetchPage } = fakeSource(301);
    const out = await fetchAllRows(fetchPage, 300);
    expect(out.rows).toHaveLength(300);
    expect(out.truncated).toBe(true);
  });

  it("throws on a DB error rather than returning a partial set", async () => {
    const fetchPage = async () => ({ data: null, error: { message: "permission denied" } });
    await expect(fetchAllRows(fetchPage, 10)).rejects.toThrow(/permission denied/);
  });
});

describe("chunk / unique", () => {
  it("splits into fixed-size chunks with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it("dedupes and drops null/undefined", () => {
    expect(unique(["a", null, "b", "a", undefined])).toEqual(["a", "b"]);
  });
});
```

and `src/lib/reports/format.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { csvManilaStamp, pluckOne } from "./format";

describe("csvManilaStamp", () => {
  it("renders a UTC instant as a Manila `YYYY-MM-DD HH:mm`", () => {
    // 2026-09-08T23:30Z is 07:30 the next morning in Manila (+08:00).
    expect(csvManilaStamp("2026-09-08T23:30:00.000Z")).toBe("2026-09-09 07:30");
  });

  it("uses a 24-hour clock without a '24' midnight", () => {
    expect(csvManilaStamp("2026-09-08T16:00:00.000Z")).toBe("2026-09-09 00:00");
  });

  it("is blank for null, undefined or garbage", () => {
    expect(csvManilaStamp(null)).toBe("");
    expect(csvManilaStamp(undefined)).toBe("");
    expect(csvManilaStamp("not a date")).toBe("");
  });
});

describe("pluckOne", () => {
  it("flattens an embed whether PostgREST returned an object or an array", () => {
    expect(pluckOne({ a: 1 })).toEqual({ a: 1 });
    expect(pluckOne([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(pluckOne([])).toBeNull();
    expect(pluckOne(null)).toBeNull();
    expect(pluckOne(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them** — `npx vitest run src/lib/reports`. Expected: FAIL (modules missing).

- [ ] **Step 3: Create `src/lib/reports/paging.ts`**

```ts
/**
 * Paging + chunking for the admin report loaders.
 *
 * PostgREST hard-caps one response at 1000 rows, so any report that can exceed
 * that has to walk the set with `.range()`; and `.in()` lists ride in the GET
 * query string, so lookups are chunked to keep URLs short. Pure — the fetcher
 * is injected, which is what keeps this vitest-testable. Not `server-only`.
 */

/** PostgREST's per-response cap. */
export const PAGE_SIZE = 1000;

/** Ids per `.in()` call. 200 UUIDs ≈ 7.5 KB of query string — well under proxy limits. */
export const IN_CHUNK = 200;

/**
 * Hard ceiling on rows a report export will walk — the same figure as
 * /api/admin/visits.csv. A report that hits it says so in-band (a TRUNCATED
 * row) and in its audit metadata rather than silently stopping.
 */
export const REPORT_EXPORT_MAX_ROWS = 20_000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function unique<T>(items: readonly (T | null | undefined)[]): T[] {
  return Array.from(
    new Set(items.filter((v): v is T => v !== null && v !== undefined)),
  );
}

/** One `.range(from, to)` call. A supabase-js builder is itself thenable and satisfies this. */
export type PageFetcher<T> = (
  from: number,
  to: number,
) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Walk `fetchPage` until the set ends or `maxRows` is reached. Asks for one
 * row past the ceiling so `truncated` is exact without a count query. The
 * query MUST carry a total order (add an `id` tie-break) or pages can repeat
 * or drop rows. Throws on a DB error — a partial export that reads as
 * complete is worse than a failed one.
 */
export async function fetchAllRows<T>(
  fetchPage: PageFetcher<T>,
  maxRows: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const want = maxRows + 1;
  const out: T[] = [];
  while (out.length < want) {
    const from = out.length;
    const to = Math.min(from + PAGE_SIZE, want) - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(`report page ${from}–${to}: ${error.message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return { rows: out.slice(0, maxRows), truncated: out.length > maxRows };
}
```

- [ ] **Step 4: Create `src/lib/reports/format.ts`**

```ts
/** Presentation helpers shared by report loaders, pages and CSV routes. Pure. */

const MANILA_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD HH:mm` in Asia/Manila — sorts as text and Excel parses it. */
export function csvManilaStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const parts = MANILA_STAMP.formatToParts(t);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * PostgREST returns an embedded relation as an object or a one-element array
 * depending on the join shape. One copy of the flattener — the report pages
 * used to carry four private ones.
 */
export function pluckOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
```

- [ ] **Step 5: Run the tests** — `npx vitest run src/lib/reports`. Expected: PASS.

- [ ] **Step 6: Create `src/lib/reports/csv-response.ts`** (server-only — it writes the audit row)

```ts
import "server-only";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { csvDocument } from "@/lib/csv/escape";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { Json } from "@/types/database";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

/**
 * The tail every admin report CSV shares: the in-band TRUNCATED row, the
 * `report.<key>.exported` audit row (RA 10173 — an export that discloses
 * patient data is attributable, and the metadata names the filters, never
 * the content), and the download response. Mirrors /api/admin/visits.csv.
 */
export async function reportCsvResponse(args: {
  staff: StaffSession;
  /** snake_case report key → audit action `report.<key>.exported`. */
  report: string;
  filename: string;
  /** Header row first, then one array per data row. */
  rows: readonly (readonly unknown[])[];
  truncated: boolean;
  /** The filters the export ran under. */
  filters: Record<string, Json>;
}): Promise<NextResponse> {
  const body = [...args.rows];
  // A silently truncated export reads as "that's everything". Say so in-band —
  // the reader of the file is not necessarily the person who clicked.
  if (args.truncated) {
    body.push([
      `TRUNCATED — more rows matched than the ${REPORT_EXPORT_MAX_ROWS} exported. Narrow the filters.`,
    ]);
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: args.staff.user_id,
    actor_type: "staff",
    action: `report.${args.report}.exported`,
    resource_type: "report",
    resource_id: null,
    metadata: {
      report: args.report,
      ...args.filters,
      rows_exported: Math.max(0, args.rows.length - 1),
      truncated: args.truncated,
    },
    ip_address: ip,
    user_agent: ua,
  });

  return new NextResponse(csvDocument(body), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${args.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 7: Create `src/components/staff/export-csv-link.tsx`** — the class string is byte-identical to the anchor on the visits page, so adopting it there changes nothing visually.

```tsx
/**
 * The one "Export CSV" control. A plain anchor on purpose: the target is a
 * Route Handler download, which must not go through next/link's client
 * navigation. Server-safe (no hooks), usable from any RSC.
 */
export function ExportCsvLink({
  href,
  label = "Export CSV",
}: {
  href: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
    >
      {label}
    </a>
  );
}
```

- [ ] **Step 8: Adopt it on the visits page.** In `src/app/(staff)/staff/(dashboard)/visits/page.tsx` add `import { ExportCsvLink } from "@/components/staff/export-csv-link";` and replace

```tsx
            {isAdmin ? (
              <a
                href={exportHref}
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
              >
                Export CSV
              </a>
            ) : null}
```

with

```tsx
            {isAdmin ? <ExportCsvLink href={exportHref} /> : null}
```

- [ ] **Step 9: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports`. Whole-tree grep: `grep -rn "Export CSV" src` — the remaining inline anchors (`admin/operations/page.tsx`, `admin/operations/expenses/page.tsx`, `admin/emails-sent/page.tsx`, `hmo-claims-client.tsx`) use *different* styling (`buttonVariants` / their own classes) and are out of scope; list them in the PR body as a follow-up, do not change them.

- [ ] **Step 10: Commit**

```bash
git add src/lib/reports src/components/staff/export-csv-link.tsx "src/app/(staff)/staff/(dashboard)/visits/page.tsx"
git commit -m "feat(reports): shared paging, CSV response and export link for admin report exports"
```

---

## The per-report pattern (Tasks 5–11)

Every report gets the same four pieces; the loader module is the only place the query lives.

```
src/lib/reports/<name>.ts        parse<X>Params · load<X>(client, params, maxRows) · <x>CsvRows · <x>CsvHref · <x>CsvFilename
src/lib/reports/<name>.test.ts   pure parts only (params, CSV rows, derivations)
src/app/api/admin/reports/<name>.csv/route.ts
src/app/(staff)/staff/(dashboard)/admin/reports/<name>/page.tsx   replaces its inline query with the loader
```

The route is the same 20 lines every time — only the names change:

```ts
import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { /* parseXParams, loadX, xCsvRows, xCsvFilename */ } from "@/lib/reports/<name>";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const params = parseXParams(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  const report = await loadX(supabase, params, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "<snake_name>",
    filename: xCsvFilename(params),
    rows: xCsvRows(report),
    truncated: report.truncated,
    filters: { ...params },
  });
}
```

Page rule: the page keeps `createAdminClient()` (unchanged behaviour), keeps its own row cap where it had one, passes the same parsed params to the loader, destructures the **same variable names its JSX already uses**, and adds `<ExportCsvLink href={xCsvHref(params)} />` beside its filter form's Apply button (or in the header when there is no form). `capped` becomes `truncated`.

---

## Task 5: Daily revenue

**Notes from the read-through:** `from`/`to` are not validated today (a bad date makes PostgREST error and the page render empty); the query has no `.limit()` so PostgREST silently caps it at 1000 rows (a busy month with many services exceeds that). The loader validates and pages. `services.code` is unique, so `(business_date desc, service_code asc)` is a total order.

**Files:** create `src/lib/reports/daily-revenue.ts`, `src/lib/reports/daily-revenue.test.ts`, `src/app/api/admin/reports/daily-revenue.csv/route.ts`; modify `src/app/(staff)/staff/(dashboard)/admin/reports/daily-revenue/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/daily-revenue.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  DAILY_REVENUE_CSV_HEADER,
  dailyRevenueCsvFilename,
  dailyRevenueCsvHref,
  dailyRevenueCsvRows,
  groupByDate,
  parseDailyRevenueParams,
  type DailyRevenueRow,
} from "./daily-revenue";

const TODAY = "2026-09-08";

describe("parseDailyRevenueParams", () => {
  it("defaults to month-to-date", () => {
    expect(parseDailyRevenueParams({}, TODAY)).toEqual({ from: "2026-09-01", to: TODAY });
  });
  it("keeps valid ISO dates", () => {
    expect(parseDailyRevenueParams({ from: "2026-08-01", to: "2026-08-31" }, TODAY)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });
  it("falls back on garbage instead of passing it to the DB", () => {
    expect(parseDailyRevenueParams({ from: "08/01/2026", to: "x" }, TODAY)).toEqual({
      from: "2026-09-01",
      to: TODAY,
    });
  });
});

const rows: DailyRevenueRow[] = [
  { business_date: "2026-09-08", service_code: "CBC", service_name: "CBC", service_kind: "lab_test", revenue_php: 350, released_count: 2 },
  { business_date: "2026-09-08", service_code: "FBS", service_name: "FBS", service_kind: "lab_test", revenue_php: 120.5, released_count: 1 },
  { business_date: "2026-09-07", service_code: "CBC", service_name: "CBC", service_kind: "lab_test", revenue_php: null, released_count: null },
];

describe("groupByDate", () => {
  it("keeps insertion order per date", () => {
    const byDate = groupByDate(rows);
    expect([...byDate.keys()]).toEqual(["2026-09-08", "2026-09-07"]);
    expect(byDate.get("2026-09-08")?.map((r) => r.service_code)).toEqual(["CBC", "FBS"]);
  });
});

describe("dailyRevenueCsvRows", () => {
  it("emits the header then one row per service-day with two-decimal pesos", () => {
    const out = dailyRevenueCsvRows(rows);
    expect(out[0]).toEqual([...DAILY_REVENUE_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08", "CBC", "CBC", "lab_test", 2, "350.00"]);
    expect(out[2]).toEqual(["2026-09-08", "FBS", "FBS", "lab_test", 1, "120.50"]);
    expect(out[3]).toEqual(["2026-09-07", "CBC", "CBC", "lab_test", 0, "0.00"]);
  });
});

describe("href / filename", () => {
  const p = { from: "2026-09-01", to: "2026-09-08" };
  it("carries the same filters the page shows", () => {
    expect(dailyRevenueCsvHref(p)).toBe("/api/admin/reports/daily-revenue.csv?from=2026-09-01&to=2026-09-08");
    expect(dailyRevenueCsvFilename(p)).toBe("daily-revenue-2026-09-01_2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL (module missing).

- [ ] **Step 3: Create `src/lib/reports/daily-revenue.ts`**

```ts
/**
 * Daily revenue by service — shared by the admin report page and its CSV.
 * Not `server-only`: takes a client so it works from an RSC and a Route
 * Handler alike (the archive-query pattern).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { fetchAllRows } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface DailyRevenueParams {
  from: string;
  to: string;
}

/** Month-to-date by default (what the page has always shown). Bad dates fall back rather than error. */
export function parseDailyRevenueParams(
  sp: { from?: string; to?: string },
  today: string = todayManilaISODate(),
): DailyRevenueParams {
  const monthStart = `${today.slice(0, 7)}-01`;
  return {
    from: isISODate(sp.from) ? sp.from : monthStart,
    to: isISODate(sp.to) ? sp.to : today,
  };
}

export interface DailyRevenueRow {
  business_date: string;
  service_code: string;
  service_name: string;
  service_kind: string;
  revenue_php: number | null;
  released_count: number | null;
}

export interface DailyRevenueReport {
  rows: DailyRevenueRow[];
  byDate: Map<string, DailyRevenueRow[]>;
  truncated: boolean;
}

export function groupByDate(rows: readonly DailyRevenueRow[]): Map<string, DailyRevenueRow[]> {
  const byDate = new Map<string, DailyRevenueRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.business_date) ?? [];
    list.push(r);
    byDate.set(r.business_date, list);
  }
  return byDate;
}

export async function loadDailyRevenue(
  client: AnyClient,
  params: DailyRevenueParams,
  maxRows: number,
): Promise<DailyRevenueReport> {
  // (business_date, service_code) is a total order — services.code is unique.
  const { rows, truncated } = await fetchAllRows<DailyRevenueRow>(
    (from, to) =>
      client
        .from("v_daily_revenue_by_service")
        .select("business_date, service_code, service_name, service_kind, revenue_php, released_count")
        .gte("business_date", params.from)
        .lte("business_date", params.to)
        .order("business_date", { ascending: false })
        .order("service_code", { ascending: true })
        .range(from, to)
        .returns<DailyRevenueRow[]>(),
    maxRows,
  );
  return { rows, byDate: groupByDate(rows), truncated };
}

export const DAILY_REVENUE_CSV_HEADER = [
  "Date",
  "Service code",
  "Service",
  "Kind",
  "Releases",
  "Revenue PHP",
] as const;

export function dailyRevenueCsvRows(rows: readonly DailyRevenueRow[]): unknown[][] {
  return [
    [...DAILY_REVENUE_CSV_HEADER],
    ...rows.map((r) => [
      r.business_date,
      r.service_code,
      r.service_name,
      r.service_kind,
      r.released_count ?? 0,
      Number(r.revenue_php ?? 0).toFixed(2),
    ]),
  ];
}

export function dailyRevenueCsvHref(p: DailyRevenueParams): string {
  return `/api/admin/reports/daily-revenue.csv?${new URLSearchParams({ from: p.from, to: p.to })}`;
}

export function dailyRevenueCsvFilename(p: DailyRevenueParams): string {
  return `daily-revenue-${p.from}_${p.to}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Create the route** — `src/app/api/admin/reports/daily-revenue.csv/route.ts`

```ts
import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  dailyRevenueCsvFilename,
  dailyRevenueCsvRows,
  loadDailyRevenue,
  parseDailyRevenueParams,
} from "@/lib/reports/daily-revenue";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const params = parseDailyRevenueParams(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  const report = await loadDailyRevenue(supabase, params, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "daily_revenue",
    filename: dailyRevenueCsvFilename(params),
    rows: dailyRevenueCsvRows(report.rows),
    truncated: report.truncated,
    filters: { ...params },
  });
}
```

- [ ] **Step 6: Refactor the page.** Replace everything in `daily-revenue/page.tsx` from `const today = todayManilaISODate();` through the end of the `byDate` loop (the `for (const r of rows ?? [])` block) with:

```ts
  const params = parseDailyRevenueParams(await searchParams);
  const { from, to } = params;

  const admin = createAdminClient();
  // Same ceiling as the export so page and CSV can never disagree; the page
  // says so when it bites.
  const { byDate, truncated } = await loadDailyRevenue(admin, params, REPORT_EXPORT_MAX_ROWS);
```

Delete the now-unused `import { todayManilaISODate } …` line and the `params` local it replaced (`const params = await searchParams;` — the new `params` is the parsed object). Add imports:

```ts
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { dailyRevenueCsvHref, loadDailyRevenue, parseDailyRevenueParams } from "@/lib/reports/daily-revenue";
```

In the header form, after the `Apply` button, add `<ExportCsvLink href={dailyRevenueCsvHref(params)} />`. After the `</header>` add:

```tsx
      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} service-days — narrow the range.
        </p>
      ) : null}
```

The JSX below is unchanged except that `typeof rows` map entries are now `DailyRevenueRow` — drop the `as string` casts on `r.business_date` / `r.service_code` / `r.service_name` / `r.service_kind` (they typecheck without them now).

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/daily-revenue.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/daily-revenue.ts src/lib/reports/daily-revenue.test.ts src/app/api/admin/reports/daily-revenue.csv "src/app/(staff)/staff/(dashboard)/admin/reports/daily-revenue/page.tsx"
git commit -m "feat(reports): daily revenue CSV export via a shared loader"
```

---

## Task 6: Staff advances

**Notes:** No search params. The detail table shows a truncated staff UUID (`staff_id.slice(0, 8)…`) because it never resolved names — the loader resolves them (chunked `staff_profiles` lookup) so both the page and the CSV show the person. The summary view is screen-only; the CSV is the advance ledger (the summary is derivable from it). `(business_date desc, id asc)` is the total order.

**Files:** create `src/lib/reports/staff-advances.ts`, `.test.ts`, `src/app/api/admin/reports/staff-advances.csv/route.ts`; modify `…/admin/reports/staff-advances/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/staff-advances.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  STAFF_ADVANCES_CSV_HEADER,
  staffAdvancesCsvFilename,
  staffAdvancesCsvHref,
  staffAdvancesCsvRows,
  type StaffAdvanceRow,
} from "./staff-advances";

const rows: StaffAdvanceRow[] = [
  { id: "a1", staff_id: "s1", business_date: "2026-09-08", original_amount_php: 2000, outstanding_balance_php: 500, status: "outstanding", source_adjustment_id: null },
  { id: "a2", staff_id: "s2", business_date: "2026-09-01", original_amount_php: 1000, outstanding_balance_php: 0, status: "settled", source_adjustment_id: "adj-1" },
];
const staffById = new Map([["s1", { full_name: "Ana Cruz", role: "reception" }]]);

describe("staffAdvancesCsvRows", () => {
  it("names the staff member and falls back to the id prefix when the profile is gone", () => {
    const out = staffAdvancesCsvRows(rows, staffById);
    expect(out[0]).toEqual([...STAFF_ADVANCES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08", "Ana Cruz", "reception", "2000.00", "500.00", "outstanding"]);
    expect(out[2]).toEqual(["2026-09-01", "s2", "", "1000.00", "0.00", "settled"]);
  });
});

describe("href / filename", () => {
  it("has no filters and stamps the day", () => {
    expect(staffAdvancesCsvHref()).toBe("/api/admin/reports/staff-advances.csv");
    expect(staffAdvancesCsvFilename("2026-09-08")).toBe("staff-advances-2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/staff-advances.ts`**

```ts
/** Staff advances — shared by the admin report page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface StaffAdvanceSummaryRow {
  staff_id: string;
  full_name: string;
  role: string;
  advance_count: number;
  outstanding_php: number | null;
  oldest_advance_date: string | null;
}

export interface StaffAdvanceRow {
  id: string;
  staff_id: string;
  business_date: string;
  original_amount_php: number;
  outstanding_balance_php: number;
  status: string;
  source_adjustment_id: string | null;
}

export type StaffNameMap = ReadonlyMap<string, { full_name: string; role: string }>;

export interface StaffAdvancesReport {
  summary: StaffAdvanceSummaryRow[];
  rows: StaffAdvanceRow[];
  staffById: StaffNameMap;
  truncated: boolean;
}

export async function loadStaffAdvances(
  client: AnyClient,
  maxRows: number,
): Promise<StaffAdvancesReport> {
  const { data: summaryRaw } = await client
    .from("v_staff_advances_outstanding")
    .select("*")
    .gt("outstanding_php", 0)
    .order("outstanding_php", { ascending: false })
    .returns<StaffAdvanceSummaryRow[]>();

  const { rows, truncated } = await fetchAllRows<StaffAdvanceRow>(
    (from, to) =>
      client
        .from("staff_advances")
        .select("id, staff_id, business_date, original_amount_php, outstanding_balance_php, status, source_adjustment_id")
        .order("business_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<StaffAdvanceRow[]>(),
    maxRows,
  );

  // Names for the ledger — the page used to show a bare UUID prefix.
  const staffById = new Map<string, { full_name: string; role: string }>();
  for (const ids of chunk(unique(rows.map((r) => r.staff_id)), IN_CHUNK)) {
    const { data } = await client
      .from("staff_profiles")
      .select("id, full_name, role")
      .in("id", ids);
    for (const s of data ?? []) staffById.set(s.id, { full_name: s.full_name, role: s.role });
  }

  return { summary: summaryRaw ?? [], rows, staffById, truncated };
}

export const STAFF_ADVANCES_CSV_HEADER = [
  "Date",
  "Staff",
  "Role",
  "Original PHP",
  "Outstanding PHP",
  "Status",
] as const;

export function staffAdvancesCsvRows(
  rows: readonly StaffAdvanceRow[],
  staffById: StaffNameMap,
): unknown[][] {
  return [
    [...STAFF_ADVANCES_CSV_HEADER],
    ...rows.map((r) => {
      const who = staffById.get(r.staff_id);
      return [
        r.business_date,
        who?.full_name ?? r.staff_id,
        who?.role ?? "",
        Number(r.original_amount_php).toFixed(2),
        Number(r.outstanding_balance_php).toFixed(2),
        r.status,
      ];
    }),
  ];
}

export function staffAdvancesCsvHref(): string {
  return "/api/admin/reports/staff-advances.csv";
}

export function staffAdvancesCsvFilename(today: string): string {
  return `staff-advances-${today}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/staff-advances.csv/route.ts`

```ts
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  loadStaffAdvances,
  staffAdvancesCsvFilename,
  staffAdvancesCsvRows,
} from "@/lib/reports/staff-advances";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. maxDuration matches it.
export const maxDuration = 60;

export async function GET() {
  const staff = await requireAdminStaff();
  const supabase = await createClient();
  const report = await loadStaffAdvances(supabase, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "staff_advances",
    filename: staffAdvancesCsvFilename(todayManilaISODate()),
    rows: staffAdvancesCsvRows(report.rows, report.staffById),
    truncated: report.truncated,
    filters: {},
  });
}
```

- [ ] **Step 6: Refactor the page.** Replace the two `await admin.from(...)` queries with:

```ts
  const admin = createAdminClient();
  const PAGE_MAX_ROWS = 500;
  const { summary, rows, staffById, truncated } = await loadStaffAdvances(admin, PAGE_MAX_ROWS);
```

Add imports for `ExportCsvLink`, `loadStaffAdvances`, `staffAdvancesCsvHref`. In the `<header>` wrap the `<h1>` so the link sits beside it:

```tsx
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">Staff advances</h1>
          <ExportCsvLink href={staffAdvancesCsvHref()} />
        </div>
```

In the summary table drop the `(summary ?? [])` fallbacks (it is always an array now) and the `as string` / `as number` casts. In the detail table replace the UUID cell

```tsx
                <td className="px-3 py-2 font-mono text-xs">{(r.staff_id as string).slice(0, 8)}…</td>
```

with

```tsx
                <td className="px-3 py-2">{staffById.get(r.staff_id)?.full_name ?? <span className="font-mono text-xs">{r.staff_id.slice(0, 8)}…</span>}</td>
```

and change the detail heading to `Recent advances (most recent {PAGE_MAX_ROWS}{truncated ? ", more not shown — export for the full ledger" : ""})`.

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/staff-advances.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/staff-advances.ts src/lib/reports/staff-advances.test.ts src/app/api/admin/reports/staff-advances.csv "src/app/(staff)/staff/(dashboard)/admin/reports/staff-advances/page.tsx"
git commit -m "feat(reports): staff advances CSV export; show staff names in the ledger"
```

---

## Task 7: Patients without consent

**Notes:** No search params. The visit-stats lookup today runs one `.in("patient_id", ids)` for up to 500 ids and counts *deleted* visits too (violates the soft-delete read rule) and silently stops at 1000 visits. The loader chunks patient ids, pages the visits per chunk, and filters `deleted_at is null`. The CSV **includes phone and email** — the page only shows presence pills, but this list exists to run a consent-capture campaign before the gate is switched on, and the export is admin-only + audited. Flag in the PR body.

**Files:** create `src/lib/reports/patients-without-consent.ts`, `.test.ts`, `src/app/api/admin/reports/patients-without-consent.csv/route.ts`; modify `…/admin/reports/patients-without-consent/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/patients-without-consent.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  orderByLastVisit,
  PATIENTS_WITHOUT_CONSENT_CSV_HEADER,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvHref,
  patientsWithoutConsentCsvRows,
  type PatientWithoutConsentRow,
} from "./patients-without-consent";

const rows: PatientWithoutConsentRow[] = [
  { id: "p1", drm_id: "DRM-1", first_name: "Ana", last_name: "Cruz", phone: "0917", email: null, pre_registered: true },
  { id: "p2", drm_id: "DRM-2", first_name: null, last_name: null, phone: null, email: "b@x.ph", pre_registered: false },
  { id: "p3", drm_id: "DRM-3", first_name: "Cy", last_name: "Dee", phone: null, email: null, pre_registered: false },
];
const visitCount = new Map([["p1", 2], ["p3", 1]]);
const lastVisit = new Map([["p1", "2026-08-01"], ["p3", "2026-09-01"]]);

describe("orderByLastVisit", () => {
  it("most recently active first, never-visited last, stable otherwise", () => {
    expect(orderByLastVisit(rows, lastVisit).map((r) => r.id)).toEqual(["p3", "p1", "p2"]);
  });
});

describe("patientsWithoutConsentCsvRows", () => {
  it("mirrors the table and adds the contact details for the campaign list", () => {
    const out = patientsWithoutConsentCsvRows(orderByLastVisit(rows, lastVisit), visitCount, lastVisit);
    expect(out[0]).toEqual([...PATIENTS_WITHOUT_CONSENT_CSV_HEADER]);
    expect(out[1]).toEqual(["Dee, Cy", "DRM-3", "no", 1, "2026-09-01", "", ""]);
    expect(out[2]).toEqual(["Cruz, Ana", "DRM-1", "yes", 2, "2026-08-01", "0917", ""]);
    expect(out[3]).toEqual(["(no name on file)", "DRM-2", "no", 0, "", "", "b@x.ph"]);
  });
});

describe("href / filename", () => {
  it("has no filters and stamps the day", () => {
    expect(patientsWithoutConsentCsvHref()).toBe("/api/admin/reports/patients-without-consent.csv");
    expect(patientsWithoutConsentCsvFilename("2026-09-08")).toBe("patients-without-consent-2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/patients-without-consent.ts`**

```ts
/** Patients with no current RA 10173 consent — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatPatientName } from "@/lib/patients/format-name";
import { chunk, fetchAllRows, IN_CHUNK } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface PatientWithoutConsentRow {
  id: string;
  drm_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  pre_registered: boolean;
}

export interface PatientsWithoutConsentReport {
  /** Ordered: most recently active first, never-visited last. */
  rows: PatientWithoutConsentRow[];
  visitCount: ReadonlyMap<string, number>;
  lastVisit: ReadonlyMap<string, string>;
  truncated: boolean;
}

/** Most recently active first; patients with no visits sink to the bottom. Stable. */
export function orderByLastVisit(
  rows: readonly PatientWithoutConsentRow[],
  lastVisit: ReadonlyMap<string, string>,
): PatientWithoutConsentRow[] {
  return [...rows].sort((a, b) =>
    (lastVisit.get(b.id) ?? "").localeCompare(lastVisit.get(a.id) ?? ""),
  );
}

export async function loadPatientsWithoutConsent(
  client: AnyClient,
  maxRows: number,
): Promise<PatientsWithoutConsentReport> {
  // Active patients (not merged tombstones) with no current data-privacy
  // consent on file — exactly the rows whose releases will block once the
  // consent gate is switched ON.
  const { rows: patients, truncated } = await fetchAllRows<PatientWithoutConsentRow>(
    (from, to) =>
      client
        .from("patients")
        .select("id, drm_id, first_name, last_name, phone, email, pre_registered")
        .eq("consent_current", false)
        .is("merged_into_id", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<PatientWithoutConsentRow[]>(),
    maxRows,
  );

  // Visit stats, folded onto each patient. Chunked ids and paged visits so a
  // frequent flyer can't push the batch past PostgREST's cap; live visits
  // only (0125).
  const visitCount = new Map<string, number>();
  const lastVisit = new Map<string, string>();
  for (const ids of chunk(patients.map((p) => p.id), IN_CHUNK)) {
    const { rows: visits } = await fetchAllRows<{ patient_id: string | null; visit_date: string | null }>(
      (from, to) =>
        client
          .from("visits")
          .select("patient_id, visit_date")
          .in("patient_id", ids)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to),
      100_000,
    );
    for (const v of visits) {
      if (!v.patient_id) continue;
      visitCount.set(v.patient_id, (visitCount.get(v.patient_id) ?? 0) + 1);
      if (v.visit_date) {
        const prev = lastVisit.get(v.patient_id);
        if (!prev || v.visit_date > prev) lastVisit.set(v.patient_id, v.visit_date);
      }
    }
  }

  return { rows: orderByLastVisit(patients, lastVisit), visitCount, lastVisit, truncated };
}

export const PATIENTS_WITHOUT_CONSENT_CSV_HEADER = [
  "Patient",
  "DRM-ID",
  "Pre-registered",
  "Visits",
  "Last visit",
  "Phone",
  "Email",
] as const;

export function patientsWithoutConsentCsvRows(
  rows: readonly PatientWithoutConsentRow[],
  visitCount: ReadonlyMap<string, number>,
  lastVisit: ReadonlyMap<string, string>,
): unknown[][] {
  return [
    [...PATIENTS_WITHOUT_CONSENT_CSV_HEADER],
    ...rows.map((p) => [
      formatPatientName(p) || "(no name on file)",
      p.drm_id,
      p.pre_registered ? "yes" : "no",
      visitCount.get(p.id) ?? 0,
      lastVisit.get(p.id) ?? "",
      p.phone ?? "",
      p.email ?? "",
    ]),
  ];
}

export function patientsWithoutConsentCsvHref(): string {
  return "/api/admin/reports/patients-without-consent.csv";
}

export function patientsWithoutConsentCsvFilename(today: string): string {
  return `patients-without-consent-${today}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/patients-without-consent.csv/route.ts`

```ts
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  loadPatientsWithoutConsent,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvRows,
} from "@/lib/reports/patients-without-consent";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. Discloses contact details, hence
// the audit row. maxDuration matches visits.csv.
export const maxDuration = 60;

export async function GET() {
  const staff = await requireAdminStaff();
  const supabase = await createClient();
  const report = await loadPatientsWithoutConsent(supabase, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "patients_without_consent",
    filename: patientsWithoutConsentCsvFilename(todayManilaISODate()),
    rows: patientsWithoutConsentCsvRows(report.rows, report.visitCount, report.lastVisit),
    truncated: report.truncated,
    filters: {},
  });
}
```

- [ ] **Step 6: Refactor the page.** Replace everything from `const { data: patients } = await admin` through the `const ordered = […].sort(…)` block with:

```ts
  const { rows: ordered, visitCount, lastVisit, truncated: capped } = await loadPatientsWithoutConsent(admin, MAX_ROWS);
  const rows = ordered;
```

(`rows` is still used for the count line; `ordered` for the table; `capped` for the notices — nothing else in the JSX changes.) Add imports for `ExportCsvLink`, `loadPatientsWithoutConsent`, `patientsWithoutConsentCsvHref`. Place `<ExportCsvLink href={patientsWithoutConsentCsvHref()} />` at the end of the `<p className="mt-2 text-sm font-semibold …">` count paragraph's parent header, as a sibling after that paragraph:

```tsx
        <div className="mt-3">
          <ExportCsvLink href={patientsWithoutConsentCsvHref()} />
        </div>
```

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/patients-without-consent.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/patients-without-consent.ts src/lib/reports/patients-without-consent.test.ts src/app/api/admin/reports/patients-without-consent.csv "src/app/(staff)/staff/(dashboard)/admin/reports/patients-without-consent/page.tsx"
git commit -m "feat(reports): patients-without-consent CSV export; count live visits only"
```

---

## Task 8: Deleted queue entries

**Notes:** Audit-log based. Today: `${start}T00:00:00+08:00` / `${end}T23:59:59+08:00` bounds (drops the last second of the end day) → use `manilaRangeUtc`; single `.in()` lookups → chunk; the per-row derivation (which row, which patient, which amount, still deleted?) lives inline in the JSX map → move it into a pure `deriveDeletedEntry` so the CSV and the table read the same fields. `(created_at desc, id asc)` is the total order.

**Files:** create `src/lib/reports/deleted-entries.ts`, `.test.ts`, `src/app/api/admin/reports/deleted-entries.csv/route.ts`; modify `…/admin/reports/deleted-entries/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/deleted-entries.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  DELETED_ENTRIES_CSV_HEADER,
  deletedEntriesCsvFilename,
  deletedEntriesCsvHref,
  deletedEntriesCsvRows,
  deriveDeletedEntry,
  parseDeletedEntriesParams,
  summariseDeletedEntries,
  type AuditRow,
  type TestRequestRow,
  type VisitRow,
} from "./deleted-entries";

const TODAY = "2026-09-08";

describe("parseDeletedEntriesParams", () => {
  it("defaults to the last 90 days", () => {
    expect(parseDeletedEntriesParams({}, TODAY)).toEqual({ start: "2026-06-10", end: TODAY });
  });
  it("rejects non-ISO input", () => {
    expect(parseDeletedEntriesParams({ start: "1/1/26", end: "2026-09-01" }, TODAY)).toEqual({
      start: "2026-06-10",
      end: "2026-09-01",
    });
  });
});

const visitDelete: AuditRow = {
  id: 1, created_at: "2026-09-08T02:00:00Z", actor_id: "u1", action: "visit.deleted",
  resource_type: "visit", resource_id: "v1",
  metadata: { total_php: 1500, active_test_count: 3, reason: "duplicate entry", visit_number: 42 },
};
const testRestore: AuditRow = {
  id: 2, created_at: "2026-09-07T02:00:00Z", actor_id: "u2", action: "test_request.restored",
  resource_type: "test_request", resource_id: "t1",
  metadata: { final_price_php: 350, service_name: "CBC", service_code: "CBC" },
};
const visitById = new Map<string, VisitRow>([
  ["v1", { id: "v1", visit_number: "0042", deleted_at: "2026-09-08T02:00:00Z", total_php: 1500, patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } }],
]);
const trById = new Map<string, TestRequestRow>([
  ["t1", { id: "t1", deleted_at: null, visit_id: "v9", services: { name: "CBC", code: "CBC" }, visits: { visit_number: "0009", deleted_at: null, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] } }],
]);
const staff = new Map([["u1", "Admin One"]]);

describe("deriveDeletedEntry", () => {
  it("resolves a visit delete from the visit row", () => {
    const e = deriveDeletedEntry(visitDelete, visitById, trById, staff);
    expect(e).toMatchObject({
      isDelete: true, isVisit: true, visitNumber: "0042", visitHref: "/staff/visits/v1",
      activeTestCount: 3, amount: 1500, currentlyDeleted: true, actorName: "Admin One",
      reason: "duplicate entry", serviceName: null, isPackageHeader: false,
    });
    expect(e.patient?.drm_id).toBe("DRM-1");
  });

  it("resolves a test restore via its visit, flattening array embeds", () => {
    const e = deriveDeletedEntry(testRestore, visitById, trById, staff);
    expect(e).toMatchObject({
      isDelete: false, isVisit: false, visitNumber: "0009", visitHref: "/staff/visits/v9",
      serviceName: "CBC", serviceCode: "CBC", amount: 350, currentlyDeleted: false, actorName: null,
    });
    expect(e.patient?.drm_id).toBe("DRM-2");
  });

  it("falls back to audit metadata when the row is gone", () => {
    const e = deriveDeletedEntry(visitDelete, new Map(), trById, staff);
    expect(e.visitNumber).toBe("42");
    expect(e.currentlyDeleted).toBe(false);
  });
});

describe("summariseDeletedEntries", () => {
  it("counts deletes, restores, still-deleted and value", () => {
    const entries = [visitDelete, testRestore].map((r) => deriveDeletedEntry(r, visitById, trById, staff));
    expect(summariseDeletedEntries(entries)).toEqual({ deleteEvents: 1, restoreEvents: 1, stillDeleted: 1, deletedValue: 1500 });
  });
});

describe("deletedEntriesCsvRows", () => {
  it("mirrors the table columns", () => {
    const entries = [visitDelete, testRestore].map((r) => deriveDeletedEntry(r, visitById, trById, staff));
    const out = deletedEntriesCsvRows(entries);
    expect(out[0]).toEqual([...DELETED_ENTRIES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08 10:00", "Deleted", "Cruz, Ana", "DRM-1", "0042", "Entire visit (3 tests)", "", "Admin One", "duplicate entry", "1500.00", "yes"]);
    expect(out[2]).toEqual(["2026-09-07 10:00", "Restored", "Dy, Ben", "DRM-2", "0009", "CBC", "CBC", "", "", "350.00", "no"]);
  });
});

describe("href / filename", () => {
  const p = { start: "2026-06-10", end: TODAY };
  it("carries the range", () => {
    expect(deletedEntriesCsvHref(p)).toBe("/api/admin/reports/deleted-entries.csv?start=2026-06-10&end=2026-09-08");
    expect(deletedEntriesCsvFilename(p)).toBe("deleted-entries-2026-06-10_2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/deleted-entries.ts`**

```ts
/** Deleted queue entries (0125 audit trail) — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export const DELETE_ACTIONS = ["visit.deleted", "test_request.deleted"] as const;
export const RESTORE_ACTIONS = ["visit.restored", "test_request.restored"] as const;
const ALL_ACTIONS = [...DELETE_ACTIONS, ...RESTORE_ACTIONS];

export interface DeletedEntriesParams {
  start: string;
  end: string;
}

/** Deletion is a corrective event, not routine — default to a wide 90-day window. */
export function parseDeletedEntriesParams(
  sp: { start?: string; end?: string },
  today: string = todayManilaISODate(),
): DeletedEntriesParams {
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -90),
    end: isISODate(sp.end) ? sp.end : today,
  };
}

export interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

export interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

export interface VisitRow {
  id: string;
  visit_number: string;
  deleted_at: string | null;
  total_php: number;
  patients: PatientEmbed | PatientEmbed[] | null;
}

type TrVisitEmbed = {
  visit_number: string;
  deleted_at: string | null;
  patients: PatientEmbed | PatientEmbed[] | null;
};

export interface TestRequestRow {
  id: string;
  deleted_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  visits: TrVisitEmbed | TrVisitEmbed[] | null;
}

/** One rendered/exported row — everything the table needs, resolved once. */
export interface DeletedEntry {
  id: number;
  createdAt: string;
  isDelete: boolean;
  isVisit: boolean;
  patient: PatientEmbed | null;
  visitNumber: string | null;
  visitHref: string | null;
  /** Visit deletes: how many live tests went with it. */
  activeTestCount: number | null;
  /** Test deletes: the service, from the row or (if gone) the audit metadata. */
  serviceName: string | null;
  serviceCode: string | null;
  isPackageHeader: boolean;
  actorName: string | null;
  reason: string | null;
  amount: number | null;
  currentlyDeleted: boolean;
}

export interface DeletedEntriesSummary {
  deleteEvents: number;
  restoreEvents: number;
  stillDeleted: number;
  deletedValue: number;
}

export interface DeletedEntriesReport {
  entries: DeletedEntry[];
  summary: DeletedEntriesSummary;
  truncated: boolean;
}

// audit_log.metadata is untyped Json — narrow it to the object shape the
// deletion writers produce before reading fields.
function asRecord(meta: Json | null): Record<string, Json | undefined> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, Json | undefined>)
    : {};
}

export function deriveDeletedEntry(
  r: AuditRow,
  visitById: ReadonlyMap<string, VisitRow>,
  trById: ReadonlyMap<string, TestRequestRow>,
  staffNameById: ReadonlyMap<string, string>,
): DeletedEntry {
  const meta = asRecord(r.metadata);
  const isDelete = (DELETE_ACTIONS as readonly string[]).includes(r.action);
  const isVisit = r.resource_type === "visit";
  const visitRow = isVisit && r.resource_id ? visitById.get(r.resource_id) : undefined;
  const trRow = !isVisit && r.resource_id ? trById.get(r.resource_id) : undefined;
  const trVisit = pluckOne(trRow?.visits ?? null);
  const patient = isVisit
    ? pluckOne(visitRow?.patients ?? null)
    : pluckOne(trVisit?.patients ?? null);
  const svc = pluckOne(trRow?.services ?? null);
  const metaVisitNumber =
    typeof meta.visit_number === "string" || typeof meta.visit_number === "number"
      ? String(meta.visit_number)
      : null;
  const visitId = isVisit
    ? r.resource_id
    : (trRow?.visit_id ?? (typeof meta.visit_id === "string" ? meta.visit_id : null));
  const amount = isVisit
    ? typeof meta.total_php === "number" ? meta.total_php : null
    : typeof meta.final_price_php === "number" ? meta.final_price_php : null;
  const currentlyDeleted = isVisit
    ? (visitRow?.deleted_at ?? null) != null
    : (trRow?.deleted_at ?? null) != null || (trVisit?.deleted_at ?? null) != null;

  return {
    id: r.id,
    createdAt: r.created_at,
    isDelete,
    isVisit,
    patient,
    visitNumber: isVisit ? (visitRow?.visit_number ?? metaVisitNumber) : (trVisit?.visit_number ?? null),
    visitHref: visitId ? `/staff/visits/${visitId}` : null,
    activeTestCount: typeof meta.active_test_count === "number" ? meta.active_test_count : null,
    serviceName: svc?.name ?? (typeof meta.service_name === "string" ? meta.service_name : null),
    serviceCode: svc?.code ?? (typeof meta.service_code === "string" ? meta.service_code : null),
    isPackageHeader: meta.is_package_header === true,
    actorName: staffNameById.get(r.actor_id ?? "") ?? null,
    reason: typeof meta.reason === "string" ? meta.reason : null,
    amount,
    currentlyDeleted,
  };
}

export function summariseDeletedEntries(entries: readonly DeletedEntry[]): DeletedEntriesSummary {
  const deletes = entries.filter((e) => e.isDelete);
  return {
    deleteEvents: deletes.length,
    restoreEvents: entries.length - deletes.length,
    stillDeleted: deletes.filter((e) => e.currentlyDeleted).length,
    deletedValue: deletes.reduce((sum, e) => sum + (e.amount ?? 0), 0),
  };
}

export async function loadDeletedEntries(
  client: AnyClient,
  params: DeletedEntriesParams,
  maxRows: number,
): Promise<DeletedEntriesReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);
  const { rows, truncated } = await fetchAllRows<AuditRow>(
    (from, to) =>
      client
        .from("audit_log")
        .select("id, created_at, actor_id, action, resource_type, resource_id, metadata")
        .in("action", ALL_ACTIONS)
        .gte("created_at", fromIso!)
        .lt("created_at", toIso!)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<AuditRow[]>(),
    maxRows,
  );

  // Current outcome of each entry — batched by resource type, chunked ids.
  const visitById = new Map<string, VisitRow>();
  const visitIds = unique(rows.filter((r) => r.resource_type === "visit").map((r) => r.resource_id));
  for (const ids of chunk(visitIds, IN_CHUNK)) {
    const { data } = await client
      .from("visits")
      .select("id, visit_number, deleted_at, total_php, patients ( first_name, last_name, drm_id )")
      .in("id", ids)
      .returns<VisitRow[]>();
    for (const v of data ?? []) visitById.set(v.id, v);
  }

  const trById = new Map<string, TestRequestRow>();
  const trIds = unique(rows.filter((r) => r.resource_type === "test_request").map((r) => r.resource_id));
  for (const ids of chunk(trIds, IN_CHUNK)) {
    const { data } = await client
      .from("test_requests")
      .select(
        `
        id, deleted_at, visit_id,
        services ( name, code ),
        visits ( visit_number, deleted_at, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", ids)
      .returns<TestRequestRow[]>();
    for (const tr of data ?? []) trById.set(tr.id, tr);
  }

  const staffNameById = new Map<string, string>();
  for (const ids of chunk(unique(rows.map((r) => r.actor_id)), IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const s of data ?? []) staffNameById.set(s.id, s.full_name);
  }

  const entries = rows.map((r) => deriveDeletedEntry(r, visitById, trById, staffNameById));
  return { entries, summary: summariseDeletedEntries(entries), truncated };
}

export const DELETED_ENTRIES_CSV_HEADER = [
  "When (Manila)",
  "Event",
  "Patient",
  "DRM-ID",
  "Visit #",
  "What",
  "Service code",
  "By",
  "Reason",
  "Amount PHP",
  "Currently deleted",
] as const;

export function deletedEntriesCsvRows(entries: readonly DeletedEntry[]): unknown[][] {
  return [
    [...DELETED_ENTRIES_CSV_HEADER],
    ...entries.map((e) => [
      csvManilaStamp(e.createdAt),
      e.isDelete ? "Deleted" : "Restored",
      e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : "",
      e.patient?.drm_id ?? "",
      e.visitNumber ?? "",
      e.isVisit
        ? `Entire visit${e.activeTestCount != null ? ` (${e.activeTestCount} ${e.activeTestCount === 1 ? "test" : "tests"})` : ""}`
        : `${e.serviceName ?? ""}${e.isPackageHeader ? " · package" : ""}`,
      e.isVisit ? "" : (e.serviceCode ?? ""),
      e.actorName ?? "",
      e.reason ?? "",
      e.amount != null ? Number(e.amount).toFixed(2) : "",
      e.currentlyDeleted ? "yes" : "no",
    ]),
  ];
}

export function deletedEntriesCsvHref(p: DeletedEntriesParams): string {
  return `/api/admin/reports/deleted-entries.csv?${new URLSearchParams({ start: p.start, end: p.end })}`;
}

export function deletedEntriesCsvFilename(p: DeletedEntriesParams): string {
  return `deleted-entries-${p.start}_${p.end}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/deleted-entries.csv/route.ts`, the standard route with `parseDeletedEntriesParams` / `loadDeletedEntries` / `deletedEntriesCsvRows(report.entries)` / `deletedEntriesCsvFilename`, `report: "deleted_entries"`, `filters: { ...params }`.

- [ ] **Step 6: Refactor the page.** Delete from the page: `DATE_RE`, `DELETE_ACTIONS`, `RESTORE_ACTIONS`, `ALL_ACTIONS`, the `AuditRow`/`PatientEmbed`/`VisitRow`/`TestRequestRow` interfaces, `pluckOne`, `asRecord`, and the `import type { Json }`. Replace everything in the component from `const todayISO = todayManilaISODate();` through `const deletedValue = …;` with:

```ts
  const todayISO = todayManilaISODate();
  const params = parseDeletedEntriesParams(sp, todayISO);
  const { start, end } = params;

  const admin = createAdminClient();
  const { entries, summary, truncated: capped } = await loadDeletedEntries(admin, params, MAX_ROWS);
  const rows = entries;
  const { deleteEvents, restoreEvents, stillDeleted, deletedValue } = summary;
```

`deleteEvents` was an array (`deleteEvents.length` in a tile) — change that tile to use `deleteEvents` directly (it is now the count). Add imports for `ExportCsvLink`, `parseDeletedEntriesParams`, `loadDeletedEntries`, `deletedEntriesCsvHref`. In the filter form add `<ExportCsvLink href={deletedEntriesCsvHref(params)} />` after the Apply button.

Rewrite the row map head: `{rows.map((r) => {` becomes `{rows.map((e) => {` and the whole `const meta = …` … `const currentlyDeleted = …;` block is deleted. Then substitute in the JSX below it:

| was | now |
|---|---|
| `key={r.id}` | `key={e.id}` |
| `new Date(r.created_at)` | `new Date(e.createdAt)` |
| `isDelete` / `isVisit` / `patient` / `visitHref` / `visitNumber` / `amount` / `currentlyDeleted` | `e.isDelete` / `e.isVisit` / `e.patient` / `e.visitHref` / `e.visitNumber` / `e.amount` / `e.currentlyDeleted` |
| `typeof meta.active_test_count === "number" ? (<p>{meta.active_test_count} …</p>) : null` | `e.activeTestCount != null ? (<p>{e.activeTestCount} {e.activeTestCount === 1 ? "test" : "tests"}</p>) : null` |
| `svc?.name ?? (typeof meta.service_name === "string" ? meta.service_name : "—")` | `e.serviceName ?? "—"` |
| `svc?.code ?? (typeof meta.service_code === "string" ? meta.service_code : "")` | `e.serviceCode ?? ""` |
| `meta.is_package_header === true ? " · package" : ""` | `e.isPackageHeader ? " · package" : ""` |
| `staffNameById.get(r.actor_id ?? "") ?? "—"` | `e.actorName ?? "—"` |
| `typeof meta.reason === "string" ? meta.reason : "—"` | `e.reason ?? "—"` |

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/deleted-entries.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/deleted-entries.ts src/lib/reports/deleted-entries.test.ts src/app/api/admin/reports/deleted-entries.csv "src/app/(staff)/staff/(dashboard)/admin/reports/deleted-entries/page.tsx"
git commit -m "feat(reports): deleted-entries CSV export via a shared loader"
```

---

## Task 9: Undone releases

**Notes:** Same shape as Task 8 (audit-log based, `test_request.release_undone`, cascade rows are `actor_type = 'system'`). Same date-bound, chunking and derivation moves.

**Files:** create `src/lib/reports/undone-releases.ts`, `.test.ts`, `src/app/api/admin/reports/undone-releases.csv/route.ts`; modify `…/admin/reports/undone-releases/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/undone-releases.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  deriveUndoneRelease,
  parseUndoneReleasesParams,
  summariseUndoneReleases,
  UNDONE_RELEASES_CSV_HEADER,
  undoneReleasesCsvFilename,
  undoneReleasesCsvHref,
  undoneReleasesCsvRows,
  type AuditRow,
  type TestRequestRow,
} from "./undone-releases";

const TODAY = "2026-09-08";

describe("parseUndoneReleasesParams", () => {
  it("defaults to the last 90 days and rejects non-ISO input", () => {
    expect(parseUndoneReleasesParams({}, TODAY)).toEqual({ start: "2026-06-10", end: TODAY });
    expect(parseUndoneReleasesParams({ start: "bad", end: "2026-09-01" }, TODAY)).toEqual({ start: "2026-06-10", end: "2026-09-01" });
  });
});

const staffUndo: AuditRow = {
  id: 1, created_at: "2026-09-08T02:00:00Z", actor_id: "u1", actor_type: "staff", resource_id: "t1",
  metadata: { reason: "wrong patient", viewed_count: 2 },
};
const cascade: AuditRow = {
  id: 2, created_at: "2026-09-08T02:00:01Z", actor_id: null, actor_type: "system", resource_id: "h1",
  metadata: { cascaded_from: "t1" },
};
const trById = new Map<string, TestRequestRow>([
  ["t1", { id: "t1", status: "released", released_at: "2026-09-08T03:00:00Z", visit_id: "v1", services: { name: "CBC", code: "CBC" }, visits: { visit_number: "0042", patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } } }],
  ["h1", { id: "h1", status: "ready_for_release", released_at: null, visit_id: "v1", services: [{ name: "Routine package", code: "ROUTINE" }], visits: { visit_number: "0042", patients: null } }],
]);
const staff = new Map([["u1", "Path One"]]);

describe("deriveUndoneRelease", () => {
  it("resolves a staff undo with reason, views and current status", () => {
    expect(deriveUndoneRelease(staffUndo, trById, staff)).toMatchObject({
      isCascade: false, actorName: "Path One", reason: "wrong patient", viewedCount: 2,
      serviceName: "CBC", serviceCode: "CBC", visitNumber: "0042", visitId: "v1",
      currentStatus: "released", releasedAt: "2026-09-08T03:00:00Z",
    });
  });
  it("marks a system cascade and flattens array embeds", () => {
    expect(deriveUndoneRelease(cascade, trById, staff)).toMatchObject({
      isCascade: true, actorName: null, reason: null, viewedCount: null,
      serviceName: "Routine package", currentStatus: "ready_for_release", patient: null,
    });
  });
});

describe("summariseUndoneReleases", () => {
  it("counts staff undos, still-unreleased, re-released and viewed-before-undo", () => {
    const entries = [staffUndo, cascade].map((r) => deriveUndoneRelease(r, trById, staff));
    expect(summariseUndoneReleases(entries)).toEqual({ staffUndos: 1, stillUnreleased: 1, reReleased: 1, viewedBeforeUndo: 1 });
  });
});

describe("undoneReleasesCsvRows", () => {
  it("mirrors the table columns", () => {
    const entries = [staffUndo, cascade].map((r) => deriveUndoneRelease(r, trById, staff));
    const out = undoneReleasesCsvRows(entries);
    expect(out[0]).toEqual([...UNDONE_RELEASES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08 10:00", "Cruz, Ana", "DRM-1", "0042", "CBC", "CBC", "Path One", "wrong patient", 2, "Re-released", "2026-09-08 11:00"]);
    expect(out[2]).toEqual(["2026-09-08 10:00", "", "", "0042", "Routine package", "ROUTINE", "System (package cascade)", "Followed its component's undo", "", "Still unreleased", ""]);
  });
});

describe("href / filename", () => {
  const p = { start: "2026-06-10", end: TODAY };
  it("carries the range", () => {
    expect(undoneReleasesCsvHref(p)).toBe("/api/admin/reports/undone-releases.csv?start=2026-06-10&end=2026-09-08");
    expect(undoneReleasesCsvFilename(p)).toBe("undone-releases-2026-06-10_2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/undone-releases.ts`**

```ts
/** Undone releases (0110 audit trail) — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export interface UndoneReleasesParams {
  start: string;
  end: string;
}

/** Undo is a rare corrective event — default to a wide 90-day window. */
export function parseUndoneReleasesParams(
  sp: { start?: string; end?: string },
  today: string = todayManilaISODate(),
): UndoneReleasesParams {
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -90),
    end: isISODate(sp.end) ? sp.end : today,
  };
}

export interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

export interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

interface VisitEmbed {
  visit_number: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

export interface TestRequestRow {
  id: string;
  status: string;
  released_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  // test_requests has no direct patients FK — reach the patient via visits.
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface UndoneRelease {
  id: number;
  createdAt: string;
  patient: PatientEmbed | null;
  visitNumber: string | null;
  visitId: string | null;
  serviceName: string | null;
  serviceCode: string | null;
  /** The 0110 trigger flipping a package header back after its component was undone. */
  isCascade: boolean;
  actorName: string | null;
  reason: string | null;
  /** Times the patient had opened the result before the undo; null = recorded before tracking existed. */
  viewedCount: number | null;
  /** Current test_requests.status, or null when the row is gone. */
  currentStatus: string | null;
  releasedAt: string | null;
}

export interface UndoneReleasesSummary {
  staffUndos: number;
  stillUnreleased: number;
  reReleased: number;
  viewedBeforeUndo: number;
}

export interface UndoneReleasesReport {
  entries: UndoneRelease[];
  summary: UndoneReleasesSummary;
  truncated: boolean;
}

function asRecord(meta: Json | null): Record<string, Json | undefined> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, Json | undefined>)
    : {};
}

export function deriveUndoneRelease(
  r: AuditRow,
  trById: ReadonlyMap<string, TestRequestRow>,
  staffNameById: ReadonlyMap<string, string>,
): UndoneRelease {
  const meta = asRecord(r.metadata);
  const tr = r.resource_id ? trById.get(r.resource_id) : undefined;
  const svc = pluckOne(tr?.services ?? null);
  const visit = pluckOne(tr?.visits ?? null);
  const isCascade = r.actor_type === "system";
  return {
    id: r.id,
    createdAt: r.created_at,
    patient: pluckOne(visit?.patients ?? null),
    visitNumber: visit?.visit_number ?? null,
    visitId: tr?.visit_id ?? null,
    serviceName: svc?.name ?? null,
    serviceCode: svc?.code ?? null,
    isCascade,
    actorName: isCascade ? null : (staffNameById.get(r.actor_id ?? "") ?? null),
    reason: isCascade ? null : typeof meta.reason === "string" ? meta.reason : null,
    viewedCount: isCascade ? null : meta.viewed_count != null ? Number(meta.viewed_count) : null,
    currentStatus: tr?.status ?? null,
    releasedAt: tr?.released_at ?? null,
  };
}

export function summariseUndoneReleases(entries: readonly UndoneRelease[]): UndoneReleasesSummary {
  const staffUndos = entries.filter((e) => !e.isCascade);
  return {
    staffUndos: staffUndos.length,
    stillUnreleased: entries.filter((e) => e.currentStatus === "ready_for_release").length,
    reReleased: entries.filter((e) => e.currentStatus === "released").length,
    viewedBeforeUndo: staffUndos.filter((e) => (e.viewedCount ?? 0) > 0).length,
  };
}

export async function loadUndoneReleases(
  client: AnyClient,
  params: UndoneReleasesParams,
  maxRows: number,
): Promise<UndoneReleasesReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);
  // Staff undos carry the reason + viewed_count; cascade rows written by the
  // 0110 trigger are actor_type='system' with metadata.cascaded_from.
  const { rows, truncated } = await fetchAllRows<AuditRow>(
    (from, to) =>
      client
        .from("audit_log")
        .select("id, created_at, actor_id, actor_type, resource_id, metadata")
        .eq("action", "test_request.release_undone")
        .gte("created_at", fromIso!)
        .lt("created_at", toIso!)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<AuditRow[]>(),
    maxRows,
  );

  const trById = new Map<string, TestRequestRow>();
  for (const ids of chunk(unique(rows.map((r) => r.resource_id)), IN_CHUNK)) {
    const { data } = await client
      .from("test_requests")
      .select(
        `
        id, status, released_at, visit_id,
        services ( name, code ),
        visits ( visit_number, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", ids)
      .returns<TestRequestRow[]>();
    for (const tr of data ?? []) trById.set(tr.id, tr);
  }

  const staffNameById = new Map<string, string>();
  const actorIds = unique(rows.filter((r) => r.actor_type === "staff").map((r) => r.actor_id));
  for (const ids of chunk(actorIds, IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const s of data ?? []) staffNameById.set(s.id, s.full_name);
  }

  const entries = rows.map((r) => deriveUndoneRelease(r, trById, staffNameById));
  return { entries, summary: summariseUndoneReleases(entries), truncated };
}

export function currentStatusLabel(e: UndoneRelease): string {
  if (!e.currentStatus) return "";
  if (e.currentStatus === "released") return "Re-released";
  if (e.currentStatus === "ready_for_release") return "Still unreleased";
  if (e.currentStatus === "cancelled") return "Cancelled";
  return e.currentStatus.replace(/_/g, " ");
}

export const UNDONE_RELEASES_CSV_HEADER = [
  "When (Manila)",
  "Patient",
  "DRM-ID",
  "Visit #",
  "Service",
  "Service code",
  "Undone by",
  "Reason",
  "Viewed before undo",
  "Current status",
  "Re-released at (Manila)",
] as const;

export function undoneReleasesCsvRows(entries: readonly UndoneRelease[]): unknown[][] {
  return [
    [...UNDONE_RELEASES_CSV_HEADER],
    ...entries.map((e) => [
      csvManilaStamp(e.createdAt),
      e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : "",
      e.patient?.drm_id ?? "",
      e.visitNumber ?? "",
      e.serviceName ?? "",
      e.serviceCode ?? "",
      e.isCascade ? "System (package cascade)" : (e.actorName ?? ""),
      e.isCascade ? "Followed its component's undo" : (e.reason ?? ""),
      e.isCascade ? "" : (e.viewedCount ?? ""),
      currentStatusLabel(e),
      e.currentStatus === "released" ? csvManilaStamp(e.releasedAt) : "",
    ]),
  ];
}

export function undoneReleasesCsvHref(p: UndoneReleasesParams): string {
  return `/api/admin/reports/undone-releases.csv?${new URLSearchParams({ start: p.start, end: p.end })}`;
}

export function undoneReleasesCsvFilename(p: UndoneReleasesParams): string {
  return `undone-releases-${p.start}_${p.end}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/undone-releases.csv/route.ts`, the standard route with `parseUndoneReleasesParams` / `loadUndoneReleases` / `undoneReleasesCsvRows(report.entries)` / `undoneReleasesCsvFilename`, `report: "undone_releases"`.

- [ ] **Step 6: Refactor the page.** Delete `DATE_RE`, the `AuditRow`/`PatientEmbed`/`VisitEmbed`/`TestRequestRow` interfaces, `pluckOne`, `asRecord`, the `Json` import. Replace from `const todayISO = todayManilaISODate();` through `const viewedBeforeUndo = …;` with:

```ts
  const todayISO = todayManilaISODate();
  const params = parseUndoneReleasesParams(sp, todayISO);
  const { start, end } = params;

  const admin = createAdminClient();
  const { entries, summary, truncated: capped } = await loadUndoneReleases(admin, params, MAX_ROWS);
  const rows = entries;
  const { staffUndos, stillUnreleased, reReleased, viewedBeforeUndo } = summary;
```

`staffUndos` was an array — the tile hint used `staffUndos.length`; use `staffUndos` directly. Add `<ExportCsvLink href={undoneReleasesCsvHref(params)} />` after the Apply button. Rewrite the row map: `{rows.map((r) => {` → `{rows.map((e) => {`, delete the `const meta …` … `const viewedCount = …;` block, and substitute:

| was | now |
|---|---|
| `key={r.id}` / `new Date(r.created_at)` | `key={e.id}` / `new Date(e.createdAt)` |
| `patient` / `visit?.visit_number` / `tr.visit_id` / `isCascade` / `viewedCount` | `e.patient` / `e.visitNumber` / `e.visitId` / `e.isCascade` / `e.viewedCount` |
| `{tr ? (<p>…#{visit?.visit_number ?? "—"}…</p>) : null}` | `{e.visitId ? (<p>…href={\`/staff/visits/${e.visitId}\`}…#{e.visitNumber ?? "—"}…</p>) : null}` |
| `{svc ? (<>{svc.name}<p>{svc.code}</p></>) : "—"}` | `{e.serviceName ? (<>{e.serviceName}<p>{e.serviceCode}</p></>) : "—"}` |
| `staffNameById.get(r.actor_id ?? "") ?? "—"` | `e.actorName ?? "—"` |
| `typeof meta.reason === "string" ? meta.reason : "—"` | `e.reason ?? "—"` |
| the outcome cell's `!tr` / `tr.status === …` / `tr.released_at` | `!e.currentStatus` / `e.currentStatus === …` / `e.releasedAt` |

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/undone-releases.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/undone-releases.ts src/lib/reports/undone-releases.test.ts src/app/api/admin/reports/undone-releases.csv "src/app/(staff)/staff/(dashboard)/admin/reports/undone-releases/page.tsx"
git commit -m "feat(reports): undone-releases CSV export via a shared loader"
```

---

## Task 10: Lab TAT analytics

**Notes — this page is broken today.** Its released query embeds `patients ( first_name, last_name )` directly on `test_requests`, but `test_requests` has **no FK to `patients`** (verified on prod: its FKs are visit, service, physician, staff, discount, hmo, parent, legacy-run). PostgREST rejects the embed, `released` comes back null, and the report renders zero data. The loader reaches the patient through `visits ( visit_number, patients ( … ) )` like every other report. It also pages (today a bare select silently stops at 1000 released tests — well under a month of production), uses the half-open Manila window, and moves the aggregation into a pure function. **The page passes `REPORT_EXPORT_MAX_ROWS` too** — metrics computed on a truncated sample are wrong, so page and CSV share the ceiling and the page says when it bites.

The CSV is the per-test TAT detail (what an analyst wants in Excel), not the on-screen section summary: one row per released test inside the outlier window, with its section, SLA and breach flag.

**Files:** create `src/lib/reports/lab-tat.ts`, `.test.ts`, `src/app/api/admin/reports/lab-tat.csv/route.ts`; modify `…/admin/reports/lab-tat/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/lab-tat.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateLabTat,
  LAB_TAT_CSV_HEADER,
  labTatCsvFilename,
  labTatCsvHref,
  labTatCsvRows,
  median,
  parseLabTatParams,
  percentile,
  type ReleasedRow,
} from "./lab-tat";

const TODAY = "2026-09-08";

describe("parseLabTatParams", () => {
  it("defaults to the last 30 days, all sections", () => {
    expect(parseLabTatParams({}, TODAY)).toEqual({ start: "2026-08-09", end: TODAY, section: "" });
  });
  it("keeps a real section and drops an unknown one", () => {
    expect(parseLabTatParams({ section: "chemistry" }, TODAY).section).toBe("chemistry");
    expect(parseLabTatParams({ section: "dentistry" }, TODAY).section).toBe("");
  });
});

describe("median / percentile", () => {
  it("handle empty, odd and even sets", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

const row = (
  id: string,
  requested: string,
  released: string | null,
  section: string | null,
  sla: number | null,
): ReleasedRow => ({
  id,
  requested_at: requested,
  released_at: released,
  status: "released",
  services: { name: `Svc ${id}`, section, turnaround_hours: sla },
  visits: { visit_number: "0001", patients: { first_name: "Ana", last_name: "Cruz" } },
});

const released: ReleasedRow[] = [
  row("a", "2026-09-01T00:00:00Z", "2026-09-01T02:00:00Z", "chemistry", 4),   // 2h, within SLA
  row("b", "2026-09-01T00:00:00Z", "2026-09-01T06:00:00Z", "chemistry", 4),   // 6h, breach
  row("c", "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z", "hematology", 24), // 92d, outlier → counted, not sampled
  row("d", "2026-09-01T00:00:00Z", null, "hematology", 24),                   // never released → skipped
];

describe("aggregateLabTat", () => {
  const agg = aggregateLabTat(released);

  it("groups per section, counting every release but sampling only sane TATs", () => {
    expect(agg.metrics.map((m) => [m.section, m.totalReleased, m.tatSamples.length, m.slaBreaches])).toEqual([
      ["chemistry", 2, 2, 1],
      ["hematology", 1, 0, 0],
    ]);
    expect(agg.metrics[0]?.worstTatRequestId).toBe("b");
  });

  it("emits one sample per sane release with the breach flag", () => {
    expect(agg.samples.map((s) => [s.requestId, s.tatHours, s.breach])).toEqual([
      ["a", 2, false],
      ["b", 6, true],
    ]);
    expect(agg.slaBreachRows.map((s) => s.requestId)).toEqual(["b"]);
  });

  it("rolls up the overall figures", () => {
    expect(agg.overall).toEqual({ median: 4, p95: 6, totalReleased: 3, totalBreaches: 1, breachPct: 33 });
  });
});

describe("labTatCsvRows", () => {
  it("one row per sample, Manila stamps, one-decimal hours", () => {
    const out = labTatCsvRows(aggregateLabTat(released).samples);
    expect(out[0]).toEqual([...LAB_TAT_CSV_HEADER]);
    expect(out[1]).toEqual(["Chemistry", "Svc a", "Cruz, Ana", "0001", "2026-09-01 08:00", "2026-09-01 10:00", "2.0", 4, "no"]);
    expect(out[2]).toEqual(["Chemistry", "Svc b", "Cruz, Ana", "0001", "2026-09-01 08:00", "2026-09-01 14:00", "6.0", 4, "yes"]);
  });
});

describe("href / filename", () => {
  it("omits an empty section and includes a set one", () => {
    expect(labTatCsvHref({ start: "2026-08-09", end: TODAY, section: "" })).toBe("/api/admin/reports/lab-tat.csv?start=2026-08-09&end=2026-09-08");
    expect(labTatCsvHref({ start: "2026-08-09", end: TODAY, section: "chemistry" })).toBe("/api/admin/reports/lab-tat.csv?start=2026-08-09&end=2026-09-08&section=chemistry");
    expect(labTatCsvFilename({ start: "2026-08-09", end: TODAY, section: "" })).toBe("lab-tat-2026-08-09_2026-09-08.csv");
    expect(labTatCsvFilename({ start: "2026-08-09", end: TODAY, section: "chemistry" })).toBe("lab-tat-2026-08-09_2026-09-08-chemistry.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/lab-tat.ts`**

```ts
/** Lab turnaround-time analytics — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { ALL_SECTIONS, type ServiceSection } from "@/lib/auth/role-sections";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { fetchAllRows } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export interface LabTatParams {
  start: string;
  end: string;
  /** "" = all sections. */
  section: ServiceSection | "";
}

export function parseLabTatParams(
  sp: { start?: string; end?: string; section?: string },
  today: string = todayManilaISODate(),
): LabTatParams {
  const section = (ALL_SECTIONS as readonly string[]).includes(sp.section ?? "")
    ? (sp.section as ServiceSection)
    : "";
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -30),
    end: isISODate(sp.end) ? sp.end : today,
    section,
  };
}

export const SECTION_LABEL: Record<string, string> = {
  chemistry: "Chemistry",
  hematology: "Hematology",
  immunology: "Immunology",
  urinalysis: "Urinalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  send_out: "Send-out",
  consultation: "Consultation",
  procedure: "Procedure",
  vaccine: "Vaccine",
  home_service: "Home service",
  package: "Package",
};

type ServicesEmbed = { name: string; section: string | null; turnaround_hours: number | null };
type PatientEmbed = { first_name: string; last_name: string };
type VisitEmbed = { visit_number: string; patients: PatientEmbed | PatientEmbed[] | null };

export interface ReleasedRow {
  id: string;
  requested_at: string;
  released_at: string | null;
  status: string;
  services: ServicesEmbed | ServicesEmbed[] | null;
  // test_requests has no direct patients FK — reach the patient via visits.
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface SectionMetric {
  section: string;
  totalReleased: number;
  pending: number;
  tatSamples: number[];
  slaBreaches: number;
  worstTatHours: number;
  worstTatRequestId: string | null;
}

export interface TatSample {
  requestId: string;
  section: string;
  serviceName: string;
  patientName: string;
  visitNumber: string;
  requestedAt: string;
  releasedAt: string;
  tatHours: number;
  slaHours: number | null;
  breach: boolean;
}

export interface LabTatAggregate {
  /** Sorted by totalReleased desc. */
  metrics: SectionMetric[];
  /** Every released test inside the outlier window, in query order. */
  samples: TatSample[];
  /** First SLA_BREACH_DETAIL_LIMIT breaches — the on-screen detail table. */
  slaBreachRows: TatSample[];
  overall: {
    median: number | null;
    p95: number | null;
    totalReleased: number;
    totalBreaches: number;
    breachPct: number;
  };
}

export interface LabTatReport extends LabTatAggregate {
  /** Requested-but-unreleased right now, regardless of window. */
  pendingTotal: number;
  truncated: boolean;
}

/** Samples beyond 60 days are garbage data (legacy imports), not slow labs. */
export const TAT_OUTLIER_HOURS = 24 * 60;
export const SLA_BREACH_DETAIL_LIMIT = 20;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

export function aggregateLabTat(released: readonly ReleasedRow[]): LabTatAggregate {
  const metricsBySection = new Map<string, SectionMetric>();
  const ensure = (section: string): SectionMetric => {
    let m = metricsBySection.get(section);
    if (!m) {
      m = { section, totalReleased: 0, pending: 0, tatSamples: [], slaBreaches: 0, worstTatHours: 0, worstTatRequestId: null };
      metricsBySection.set(section, m);
    }
    return m;
  };

  const samples: TatSample[] = [];
  for (const tr of released) {
    if (!tr.released_at) continue;
    const svc = pluckOne(tr.services);
    if (!svc) continue;
    const sec = svc.section ?? "(unset)";
    const m = ensure(sec);
    m.totalReleased += 1;

    const tatHours = (Date.parse(tr.released_at) - Date.parse(tr.requested_at)) / 3_600_000;
    if (!(tatHours >= 0 && tatHours < TAT_OUTLIER_HOURS)) continue;

    m.tatSamples.push(tatHours);
    if (tatHours > m.worstTatHours) {
      m.worstTatHours = tatHours;
      m.worstTatRequestId = tr.id;
    }
    const slaHours = svc.turnaround_hours ?? null;
    const breach = slaHours !== null && tatHours > slaHours;
    if (breach) m.slaBreaches += 1;

    const v = pluckOne(tr.visits);
    const p = pluckOne(v?.patients ?? null);
    samples.push({
      requestId: tr.id,
      section: sec,
      serviceName: svc.name,
      patientName: p ? `${p.last_name}, ${p.first_name}` : "Walk-in",
      visitNumber: v?.visit_number ?? "—",
      requestedAt: tr.requested_at,
      releasedAt: tr.released_at,
      tatHours,
      slaHours,
      breach,
    });
  }

  const metrics = Array.from(metricsBySection.values()).sort((a, b) => b.totalReleased - a.totalReleased);
  const allSamples = metrics.flatMap((r) => r.tatSamples);
  const totalReleased = metrics.reduce((s, r) => s + r.totalReleased, 0);
  const totalBreaches = metrics.reduce((s, r) => s + r.slaBreaches, 0);
  return {
    metrics,
    samples,
    slaBreachRows: samples.filter((s) => s.breach).slice(0, SLA_BREACH_DETAIL_LIMIT),
    overall: {
      median: median(allSamples),
      p95: percentile(allSamples, 0.95),
      totalReleased,
      totalBreaches,
      breachPct: totalReleased > 0 ? Math.round((totalBreaches / totalReleased) * 100) : 0,
    },
  };
}

export async function loadLabTat(
  client: AnyClient,
  params: LabTatParams,
  maxRows: number,
): Promise<LabTatReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);

  // Released test_requests in the window (the TAT samples).
  const { rows: released, truncated } = await fetchAllRows<ReleasedRow>((from, to) => {
    let q = client
      .from("test_requests")
      .select(
        `
        id, requested_at, released_at, status,
        services!inner ( name, section, turnaround_hours ),
        visits ( visit_number, patients ( first_name, last_name ) )
      `,
      )
      .eq("status", "released")
      .gte("released_at", fromIso!)
      .lt("released_at", toIso!)
      .order("released_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (params.section) q = q.eq("services.section", params.section);
    return q.returns<ReleasedRow[]>();
  }, maxRows);

  // Pending = requested but not yet released, regardless of window (what is
  // currently stuck). Live lines only (0125).
  let pendingQ = client
    .from("test_requests")
    .select("id, services!inner ( section )", { count: "exact", head: true })
    .in("status", ["requested", "in_progress", "result_uploaded", "ready_for_release"])
    .is("deleted_at", null);
  if (params.section) pendingQ = pendingQ.eq("services.section", params.section);
  const { count: pendingTotal } = await pendingQ;

  return { ...aggregateLabTat(released), pendingTotal: pendingTotal ?? 0, truncated };
}

export const LAB_TAT_CSV_HEADER = [
  "Section",
  "Service",
  "Patient",
  "Visit #",
  "Requested (Manila)",
  "Released (Manila)",
  "TAT hours",
  "SLA hours",
  "SLA breach",
] as const;

export function labTatCsvRows(samples: readonly TatSample[]): unknown[][] {
  return [
    [...LAB_TAT_CSV_HEADER],
    ...samples.map((s) => [
      SECTION_LABEL[s.section] ?? s.section,
      s.serviceName,
      s.patientName,
      s.visitNumber,
      csvManilaStamp(s.requestedAt),
      csvManilaStamp(s.releasedAt),
      s.tatHours.toFixed(1),
      s.slaHours ?? "",
      s.breach ? "yes" : "no",
    ]),
  ];
}

export function labTatCsvHref(p: LabTatParams): string {
  const qs = new URLSearchParams({ start: p.start, end: p.end });
  if (p.section) qs.set("section", p.section);
  return `/api/admin/reports/lab-tat.csv?${qs}`;
}

export function labTatCsvFilename(p: LabTatParams): string {
  return `lab-tat-${p.start}_${p.end}${p.section ? `-${p.section}` : ""}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/lab-tat.csv/route.ts`, the standard route with `parseLabTatParams` / `loadLabTat` / `labTatCsvRows(report.samples)` / `labTatCsvFilename`, `report: "lab_tat"`, `filters: { ...params }`.

- [ ] **Step 6: Refactor the page.** Delete from the page: `DATE_RE`, `ReleasedRow`, `SectionMetric`, `pluckOne`, `median`, `percentile`, `SECTION_LABEL` (import it from the loader — the section `<select>` and both tables use it), and the `ALL_SECTIONS` import stays (the `<select>` still lists it). Keep `formatHours`. Replace from `const todayISO = todayManilaISODate();` through `const overallBreachPct = …;` with:

```ts
  const todayISO = todayManilaISODate();
  const params = parseLabTatParams(sp, todayISO);
  const { start, end, section: sectionFilter } = params;

  const admin = createAdminClient();
  // The metrics are only right on the WHOLE window, so the page walks the
  // same ceiling as the export and says so if it bites.
  const { metrics: rows, slaBreachRows, pendingTotal, overall, truncated } =
    await loadLabTat(admin, params, REPORT_EXPORT_MAX_ROWS);
  const { median: overallMedian, p95: overallP95, totalReleased, totalBreaches, breachPct: overallBreachPct } = overall;
```

(`rows` keeps its name because the section table maps over it; `pendingTotal` was the old `count` variable — grep the JSX for `pendingTotal` and keep it.) Add imports for `ExportCsvLink`, `REPORT_EXPORT_MAX_ROWS`, and `{ loadLabTat, parseLabTatParams, labTatCsvHref, SECTION_LABEL }`. Add `<ExportCsvLink href={labTatCsvHref(params)} />` after the Apply button, and directly after the `</form>`:

```tsx
      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Metrics are computed on the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} released tests in this window — narrow the range for exact figures.
        </p>
      ) : null}
```

Remove `totalBreaches` from the destructure if the JSX never reads it (lint would flag an unused variable).

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/lab-tat.test.ts`. Then **prove the page fix**: on the Vercel preview (or `npm run dev` against local), open `/staff/admin/reports/lab-tat` as admin — it must now show non-zero "Released" for a window that has released tests. Record the before/after in the PR body.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/lab-tat.ts src/lib/reports/lab-tat.test.ts src/app/api/admin/reports/lab-tat.csv "src/app/(staff)/staff/(dashboard)/admin/reports/lab-tat/page.tsx"
git commit -m "fix(reports): lab TAT reads the patient via visits (page was empty); CSV export; page the sample"
```

---

## Task 11: Stuck tests

**Notes:** Four lists (stuck tests, package headers not auto-released, orphan headers, empty visits) with different shapes; the last three are integrity checks that should be ~0. One CSV with a leading `List` column and the union of columns keeps every row exportable without four downloads. The main list pages; the three integrity lists keep their 100-row caps (they are anomalies, not ledgers). `ageDays` takes an injectable `now` so it is testable.

**Files:** create `src/lib/reports/stuck-tests.ts`, `.test.ts`, `src/app/api/admin/reports/stuck-tests.csv/route.ts`; modify `…/admin/reports/stuck-tests/page.tsx`.

- [ ] **Step 1: Failing test** — `src/lib/reports/stuck-tests.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  ageDays,
  parseStuckTestsParams,
  STUCK_TESTS_CSV_HEADER,
  stuckTestsCsvFilename,
  stuckTestsCsvHref,
  stuckTestsCsvRows,
  type EmptyVisitRow,
  type StuckRow,
} from "./stuck-tests";

describe("parseStuckTestsParams", () => {
  it("defaults to 3 days and clamps to 1..365 whole days", () => {
    expect(parseStuckTestsParams({})).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "10.9" })).toEqual({ days: 10 });
    expect(parseStuckTestsParams({ days: "0" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "400" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "abc" })).toEqual({ days: 3 });
  });
});

describe("ageDays", () => {
  it("floors whole days from an injected now", () => {
    const now = Date.parse("2026-09-08T10:00:00Z");
    expect(ageDays("2026-09-05T11:00:00Z", now)).toBe(2);
    expect(ageDays("2026-09-05T09:00:00Z", now)).toBe(3);
  });
});

const NOW = Date.parse("2026-09-08T10:00:00Z");
const stuck: StuckRow = {
  id: "t1", status: "in_progress", requested_at: "2026-09-01T02:00:00Z", assigned_to: "u1", visit_id: "v1",
  services: { code: "CBC", name: "CBC" },
  visits: { visit_number: "0042", payment_status: "paid", patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } },
};
const header: StuckRow = {
  id: "h1", status: "ready_for_release", requested_at: "2026-09-02T02:00:00Z", assigned_to: null, visit_id: "v2",
  services: [{ code: "ROUTINE", name: "Routine package" }],
  visits: [{ visit_number: "0043", payment_status: "waived", patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
};
const empty: EmptyVisitRow = {
  id: "v3", visit_number: "0044", created_at: "2026-09-07T02:00:00Z", total_php: 0, payment_status: "unpaid",
  patients: { first_name: "Cy", last_name: "Ek", drm_id: "DRM-3" },
};

describe("stuckTestsCsvRows", () => {
  it("unions the four lists under a List column", () => {
    const out = stuckTestsCsvRows(
      { stuck: [stuck], stuckHeaders: [header], orphanHeaders: [], emptyVisits: [empty] },
      new Map([["u1", "Med Tech"]]),
      NOW,
    );
    expect(out[0]).toEqual([...STUCK_TESTS_CSV_HEADER]);
    expect(out[1]).toEqual(["Stuck test", 7, "2026-09-01 10:00", "0042", "Cruz, Ana", "DRM-1", "CBC", "CBC", "in_progress", "Med Tech", "paid", ""]);
    expect(out[2]).toEqual(["Package header not auto-released", 6, "2026-09-02 10:00", "0043", "Dy, Ben", "DRM-2", "ROUTINE", "Routine package", "ready_for_release", "", "waived", ""]);
    expect(out[3]).toEqual(["Visit with no tests", 1, "2026-09-07 10:00", "0044", "Ek, Cy", "DRM-3", "", "", "", "", "unpaid", "0.00"]);
  });
});

describe("href / filename", () => {
  it("carries the threshold", () => {
    expect(stuckTestsCsvHref({ days: 3 })).toBe("/api/admin/reports/stuck-tests.csv?days=3");
    expect(stuckTestsCsvFilename({ days: 3 }, "2026-09-08")).toBe("stuck-tests-3d-2026-09-08.csv");
  });
});
```

- [ ] **Step 2: Run it** — expected FAIL.

- [ ] **Step 3: Create `src/lib/reports/stuck-tests.ts`**

```ts
/** Stuck tests + queue-integrity checks — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export interface StuckTestsParams {
  days: number;
}

export function parseStuckTestsParams(sp: { days?: string }): StuckTestsParams {
  const raw = Number(sp.days);
  return {
    days: Number.isFinite(raw) && raw >= 1 && raw <= 365 ? Math.floor(raw) : 3,
  };
}

type PatientEmbed = { first_name: string; last_name: string; drm_id: string };
type VisitEmbed = {
  visit_number: string;
  payment_status: string;
  patients: PatientEmbed | PatientEmbed[] | null;
};

export interface StuckRow {
  id: string;
  status: string;
  requested_at: string;
  assigned_to: string | null;
  visit_id: string;
  services: { code: string; name: string } | { code: string; name: string }[] | null;
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface EmptyVisitRow {
  id: string;
  visit_number: string;
  created_at: string;
  total_php: number;
  payment_status: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

export interface StuckTestsLists {
  /** Non-final tests older than the threshold (the main table). */
  stuck: StuckRow[];
  /** Package headers at ready_for_release on paid visits whose components are all terminal — 0109 should have auto-released them. */
  stuckHeaders: StuckRow[];
  /** Package headers with no component rows at all. */
  orphanHeaders: StuckRow[];
  /** Visits with no test_request rows, older than an hour. */
  emptyVisits: EmptyVisitRow[];
}

export interface StuckTestsReport extends StuckTestsLists {
  claimerNames: ReadonlyMap<string, string>;
  truncated: boolean;
}

export function ageDays(requestedAt: string, now: number = Date.now()): number {
  return Math.floor((now - new Date(requestedAt).getTime()) / (1000 * 60 * 60 * 24));
}

function cutoffIso(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

const STUCK_SELECT = `
  id, status, requested_at, assigned_to, visit_id,
  services!inner ( code, name ),
  visits!inner (
    visit_number, payment_status,
    patients!inner ( first_name, last_name, drm_id )
  )
`;

export async function loadStuckTests(
  client: AnyClient,
  params: StuckTestsParams,
  maxRows: number,
  now: number = Date.now(),
): Promise<StuckTestsReport> {
  const cutoff = cutoffIso(params.days, now);

  // Non-final tests older than the threshold. No direct patients embed on
  // test_requests — join via visits(patients(...)). A deleted line isn't
  // stuck — it's not owed at all (0125).
  const { rows: stuck, truncated } = await fetchAllRows<StuckRow>(
    (from, to) =>
      client
        .from("test_requests")
        .select(STUCK_SELECT)
        .in("status", ["requested", "in_progress", "result_uploaded", "ready_for_release"])
        .eq("is_package_header", false)
        .lt("requested_at", cutoff)
        .is("deleted_at", null)
        .is("visits.deleted_at", null)
        .order("requested_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<StuckRow[]>(),
    maxRows,
  );

  const claimerNames = new Map<string, string>();
  for (const ids of chunk(unique(stuck.map((r) => r.assigned_to)), IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const p of data ?? []) claimerNames.set(p.id, p.full_name);
  }

  // Zero-child package headers — 0130's Population-A predicates, live. Since
  // the atomic visit-creation fix these can no longer be minted, so anything
  // here is pre-fix damage 0130 missed or a regression. The embed hint is the
  // parent_id column (self-referential FK); `.is("components", null)` makes
  // the left-joined embed an anti-join.
  const { data: orphanRaw } = await client
    .from("test_requests")
    .select(`${STUCK_SELECT}, components:test_requests!parent_id ( id )`)
    .eq("is_package_header", true)
    .in("status", ["in_progress", "ready_for_release"])
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .is("components", null)
    .order("requested_at", { ascending: true })
    .limit(100)
    .returns<StuckRow[]>();

  // Visits with NO test_request rows — the one partial-write shape the atomic
  // insert still permits. Older than an hour so a request in flight can't
  // false-positive.
  const { data: emptyVisitsRaw } = await client
    .from("visits")
    .select(
      `
      id, visit_number, created_at, total_php, payment_status,
      patients!inner ( first_name, last_name, drm_id ),
      lines:test_requests ( id )
    `,
    )
    .is("deleted_at", null)
    .is("lines", null)
    .lt("created_at", cutoffIso(1 / 24, now))
    .order("created_at", { ascending: true })
    .limit(100)
    .returns<EmptyVisitRow[]>();

  // Package HEADERS sitting at ready_for_release on paid visits whose
  // components are all terminal with ≥1 released — post-0109 this should be
  // empty; anything here means the auto-release didn't fire.
  const { data: headersRaw } = await client
    .from("test_requests")
    .select(STUCK_SELECT)
    .eq("is_package_header", true)
    .eq("status", "ready_for_release")
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .limit(100)
    .returns<StuckRow[]>();

  const headerCandidates = (headersRaw ?? []).filter((h) => {
    const visit = pluckOne(h.visits);
    return visit?.payment_status === "paid" || visit?.payment_status === "waived";
  });

  const stuckHeaders: StuckRow[] = [];
  if (headerCandidates.length > 0) {
    const byParent = new Map<string, string[]>();
    for (const ids of chunk(headerCandidates.map((h) => h.id), IN_CHUNK)) {
      const { data: components } = await client
        .from("test_requests")
        .select("parent_id, status")
        .in("parent_id", ids);
      for (const c of components ?? []) {
        if (!c.parent_id) continue;
        const list = byParent.get(c.parent_id) ?? [];
        list.push(c.status);
        byParent.set(c.parent_id, list);
      }
    }
    for (const h of headerCandidates) {
      const statuses = byParent.get(h.id) ?? [];
      const allTerminal =
        statuses.length > 0 && statuses.every((s) => s === "released" || s === "cancelled");
      if (allTerminal && statuses.some((s) => s === "released")) stuckHeaders.push(h);
    }
  }

  return {
    stuck,
    stuckHeaders,
    orphanHeaders: orphanRaw ?? [],
    emptyVisits: emptyVisitsRaw ?? [],
    claimerNames,
    truncated,
  };
}

export const STUCK_TESTS_CSV_HEADER = [
  "List",
  "Age (days)",
  "Requested / created (Manila)",
  "Visit #",
  "Patient",
  "DRM-ID",
  "Test code",
  "Test",
  "Status",
  "Claimed by",
  "Visit payment",
  "Visit total PHP",
] as const;

function testRow(list: string, r: StuckRow, claimerNames: ReadonlyMap<string, string>, now: number): unknown[] {
  const svc = pluckOne(r.services);
  const visit = pluckOne(r.visits);
  const patient = visit ? pluckOne(visit.patients) : null;
  return [
    list,
    ageDays(r.requested_at, now),
    csvManilaStamp(r.requested_at),
    visit?.visit_number ?? "",
    patient ? `${patient.last_name}, ${patient.first_name}` : "",
    patient?.drm_id ?? "",
    svc?.code ?? "",
    svc?.name ?? "",
    r.status,
    r.assigned_to ? (claimerNames.get(r.assigned_to) ?? "") : "",
    visit?.payment_status ?? "",
    "",
  ];
}

export function stuckTestsCsvRows(
  lists: StuckTestsLists,
  claimerNames: ReadonlyMap<string, string>,
  now: number = Date.now(),
): unknown[][] {
  return [
    [...STUCK_TESTS_CSV_HEADER],
    ...lists.stuck.map((r) => testRow("Stuck test", r, claimerNames, now)),
    ...lists.stuckHeaders.map((r) => testRow("Package header not auto-released", r, claimerNames, now)),
    ...lists.orphanHeaders.map((r) => testRow("Package header with no components", r, claimerNames, now)),
    ...lists.emptyVisits.map((v) => {
      const patient = pluckOne(v.patients);
      return [
        "Visit with no tests",
        ageDays(v.created_at, now),
        csvManilaStamp(v.created_at),
        v.visit_number,
        patient ? `${patient.last_name}, ${patient.first_name}` : "",
        patient?.drm_id ?? "",
        "",
        "",
        "",
        "",
        v.payment_status,
        Number(v.total_php).toFixed(2),
      ];
    }),
  ];
}

export function stuckTestsCsvHref(p: StuckTestsParams): string {
  return `/api/admin/reports/stuck-tests.csv?days=${p.days}`;
}

export function stuckTestsCsvFilename(p: StuckTestsParams, today: string): string {
  return `stuck-tests-${p.days}d-${today}.csv`;
}
```

- [ ] **Step 4: Run the test** — expected PASS.

- [ ] **Step 5: Route** — `src/app/api/admin/reports/stuck-tests.csv/route.ts`, the standard route with `parseStuckTestsParams` / `loadStuckTests` / `stuckTestsCsvRows(report, report.claimerNames)` / `stuckTestsCsvFilename(params, todayManilaISODate())`, `report: "stuck_tests"`, `filters: { ...params }`.

- [ ] **Step 6: Refactor the page.** Delete `StuckRow`, `pluckOne`, `ageDays`, `cutoffIso` from the page (import `pluckOne` from `@/lib/reports/format` and `ageDays` from the loader — the JSX uses both). Replace from `const params = await searchParams;` through the end of the `stuckHeaders` computation (`if (headerCandidates.length > 0) { … }`) with:

```ts
  const params = parseStuckTestsParams(await searchParams);
  const { days } = params;

  const admin = createAdminClient();
  const PAGE_MAX_ROWS = 500;
  const { stuck, stuckHeaders, orphanHeaders, emptyVisits, claimerNames, truncated } =
    await loadStuckTests(admin, params, PAGE_MAX_ROWS);
```

Change the `{stuck.length === 500 ? (` notice to `{truncated ? (` and its copy to `Showing the oldest {PAGE_MAX_ROWS} rows — there may be more. Raise the day threshold to narrow the list, or export for everything.`. Inside the `PageHeader` `actions` form, after the Apply button, add `<ExportCsvLink href={stuckTestsCsvHref(params)} />`. Nothing else in the four tables changes (`emptyVisits` rows now come typed as `EmptyVisitRow`; drop any `as` casts that become redundant).

- [ ] **Step 7: Verify** — `npm run typecheck && npm run lint && npx vitest run src/lib/reports/stuck-tests.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/stuck-tests.ts src/lib/reports/stuck-tests.test.ts src/app/api/admin/reports/stuck-tests.csv "src/app/(staff)/staff/(dashboard)/admin/reports/stuck-tests/page.tsx"
git commit -m "feat(reports): stuck-tests CSV export via a shared loader"
```

---

## Task 12: Whole-tree checks, full verification, code review, PR

- [ ] **Step 1: Whole-tree greps (per-agent file ownership hides siblings).** Each must come back as stated:

```bash
# pluckOne: exactly one definition, in src/lib/reports/format.ts
grep -rn "function pluckOne" src
# no report page still builds its own T23:59:59 bound
grep -rn "T23:59:59" "src/app/(staff)/staff/(dashboard)/admin/reports"
# every report page has the link; every route audits under the prefix
grep -rln "ExportCsvLink" "src/app/(staff)/staff/(dashboard)/admin/reports" | wc -l   # 7
grep -rn 'report: "' src/app/api/admin/reports | wc -l                                  # 7
# no report page reaches the DB except through its loader
grep -rn "\.from(\"" "src/app/(staff)/staff/(dashboard)/admin/reports"                  # nothing
# the self-registration row shape exists once
grep -rn 'method: "self_registration"' src                                              # only self-registration.ts
# no server-only module is imported by a vitest-covered module
grep -rln "server-only" src/lib/reports src/lib/consent/self-registration.ts src/lib/auth/role-sections.ts  # only csv-response.ts
```

- [ ] **Step 2: Full verification** — from the worktree root:

```bash
npm test && npm run typecheck && npm run lint
```

Expected: every suite passing (910 baseline + the new files: role-sections, self-registration, paging, format, and the seven report tests), typecheck clean, lint 0 errors and exactly the 2 pre-existing warnings. Paste the three summary lines into the PR body.

- [ ] **Step 3: Code review.** Dispatch the review (Sonnet) against `git diff origin/main...HEAD` with this checklist in the prompt — the reviewer must read the actual diff, not this plan:
  - Item 1: both actions deny out-of-section ids server-side; the `scopeToAllowedSections` call receives the row *with* `id` and `services`; the UPDATE still re-checks status.
  - Item 2: `unclaimOwnTestAction` cannot unclaim someone else's claim (WHERE has `assigned_to = session.user_id`); admin path behaviour unchanged except the `deleted_at` filter; the button never renders for admin (they get the panel).
  - Item 3: the consent insert fires only when `resolution === "created"`; `/register` still writes the identical row; audit metadata carries `consent_recorded`.
  - Item 4: every route uses `requireAdminStaff` + `createClient()` (never `createAdminClient`); every loader pages under a total order; every `.in()` is chunked; every CSV that carries patient data goes through `reportCsvResponse` (audit row); `ExportCsvLink` hrefs are built from the *parsed* params; the pages' visible behaviour is unchanged apart from the export link, the truncation notices, and the three deliberate fixes (lab-tat patient join, staff-advance names, live-visits-only consent counts).
  - Security: no `any`, no service-role client in a route, no PII in audit metadata, no new public endpoint that trusts its caller.

- [ ] **Step 4: Fix anything the review flags that is a real gap** by matching the existing pattern (rule 4 in the user's collaboration rules), re-run Step 2, commit.

- [ ] **Step 5: Push and open the PR** (`git push` / `gh` need `dangerouslyDisableSandbox: true`; the first push of a session sometimes times out and succeeds on retry). PR title: `fix(staff): flow-review medium fixes — section-scoped release, self-unclaim, /schedule consent, report CSV exports (PR 3)`. Body sections: What changed (the four items in plain language), **Pre-existing bugs fixed on the way** (lab-tat page rendered empty — no `test_requests→patients` FK; daily-revenue/lab-tat silently capped at 1000 rows; patients-without-consent counted deleted visits; admin unclaim accepted soft-deleted lines), **Deliberate choices to confirm** (patients-without-consent CSV includes phone/email; stuck-tests CSV is a union with a `List` column; lab-tat CSV is per-test detail, not the section summary; report audit action names `report.<name>.exported`), **Not in this PR** (user-guide line "Only Admin can unclaim" and the ch. 8 limitations list → PR 4; the other inline "Export CSV" anchors on operations/emails-sent/hmo-claims keep their own styling; `/api/admin/visits.csv` untouched), the three verification lines, and the review outcome. Then ask the user to merge.

---

## Self-review (done while writing — recorded so the executor doesn't redo it)

**Spec coverage.** Memory item 1 → Task 1 (both actions, doctor lines admin/pathologist-only via the null-section rule, pinned by the new test). Item 2 → Task 2 (own claims only, audited with `self_service: true`, admin panel unchanged, shared core = "the admin unclaim action's shape"). Item 3 → Task 3 (`created` only, method `self_registration`, no migration; `/register` adopts the shared builder). Item 4 → Tasks 4–11 (seven pages, admin gate, RLS client, ceiling, `*.exported` audit row, following `/api/admin/visits.csv`).

**Placeholder scan.** The five "standard route" steps (Tasks 8–11) point at the verbatim template at the top of the per-report section and name every symbol to substitute; Task 5's route is written out in full as the reference. No TBDs.

**Type consistency.** `SelectableRow` needs `id` + `services` — both selects include `id`. `StaffSession` is imported type-only into `queue/actions.ts`. `PatientResolution["resolution"]` is the union the schedule action already produces. `fetchAllRows<T>` fetchers end in `.returns<T[]>()` so `data` is `T[] | null`. `ExportCsvLink` is a server-safe component (no hooks) so it renders from RSC pages. Report keys used in `reportCsvResponse` (`daily_revenue`, `staff_advances`, `patients_without_consent`, `deleted_entries`, `undone_releases`, `lab_tat`, `stuck_tests`) match the seven route files.

**Known judgment calls the user may overrule** (surfaced in the review message): contact details in the consent CSV; the `List`-column union for stuck-tests; per-test rows for lab-tat; the page-side cap raise on daily-revenue/lab-tat; the `deleted_at` filter added to the admin unclaim.
