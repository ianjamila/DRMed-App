# Release-Lifecycle + Audit-Remediation Programme — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Pause for user review after each PR and before every remote db push.**

**Goal:** Implement the approved release-lifecycle spec (PRs 1–4: queue Released column; package release + harmonized visit layout; undo release; undone-releases report) followed by the approved audit remediation (PRs 5–9: payments integrity, lab-queue operations, booking hardening, consent + notification correctness, portal RLS enforcement).

**Architecture:** Next.js 16 App Router + Supabase (Postgres 17). DB triggers are the source of truth for payment/consent gating and GL bookkeeping; server actions are user-scoped (RLS) unless a documented exception; every write audit-logged (RA 10173). New migrations are numbered **0109+**.

**Tech stack:** TypeScript strict, zod, vitest (pure logic only), supabase CLI local stack, `@sentry/nextjs` via `reportError()`.

**Source documents (binding):**
- Spec: `docs/superpowers/specs/2026-07-04-release-lifecycle-design.md` (⟨audit⟩ amendments are binding)
- Audit + §8 remediation order: `docs/superpowers/audits/2026-07-04-registration-to-release-audit.md`

---

## 0. Programme-wide facts (read before ANY task)

### 0.1 Verified-live discovery that AMENDS the audit (2026-07-04, this plan)

The audit's §1 claim "0041 guard present in live fn" is **wrong**. Verified via
`pg_get_functiondef` against prod (`qhptbmafrosgibooelpp`):

- Live `bridge_test_request_released()` has the `legacy_import_run_id` guard but
  **NO `parent_id` component-skip guard** — 0064's wholesale rewrite dropped 0041's guard.
- `je_status_balance_check()` raises **P0003** when a JE flips draft→posted with zero lines.
- Package components carry ₱0 prices ⇒ releasing any component today creates a JE
  header, inserts zero lines, flips to posted ⇒ **P0003 aborts the whole release UPDATE**.
- Live data confirms: 0 released components, 0 component JEs, 0 zero-line posted JEs ever.

**Consequence:** PR 2's migration MUST `create or replace` both bridge functions
to restore the guard (based on the LIVE definitions, which include the
`legacy_import_run_id` guard — not the 0064 file text). Without this, every
Feature-1 release button is dead on arrival.

### 0.2 Migration workflow (all migrations in this programme)

- Highest local migration: `0108_services_image_url.sql`. New numbers: **0109, 0110, 0111, 0112, 0113…** sequential, zero-padded.
- Local test loop: `supabase start` → `supabase db reset` → run the PR's SQL test runbook → `npm run db:types` → `npm test && npm run typecheck && npm run build`.
- **There is NO staging Supabase project** (verified via `list_projects`: only `qhptbmafrosgibooelpp` = prod). "PR → staging → prod" collapses to: local stack verification + Vercel preview build, then ONE reviewed push to prod. **Every prod push is a user checkpoint — stop and ask.**
- **Remote push from this machine:** `supabase db push` fails (IPv6-only direct host). Use either:
  - **Supabase MCP `execute_sql`** to run the DDL, then record the version yourself:
    `insert into supabase_migrations.schema_migrations (version, name, statements) values ('0109', '<name>', array['<stmt>;', …]);` (do NOT use MCP `apply_migration` — it records a timestamp version), or
  - the IPv4 session pooler URL: `postgresql://postgres.qhptbmafrosgibooelpp:<pw>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` with `supabase db push --db-url`.
- **One-time repair before the FIRST remote push (PR 2):** remote history holds 8 timestamped versions (20260604174218 … 20260618061210) that correspond to local files 0092–0097, 0104, 0108 (which show as un-applied under their numeric versions). Reconcile (after confirming the mapping by reading `supabase_migrations.schema_migrations.name` for those 8 rows):
  ```bash
  supabase migration repair --status applied 0092 0093 0094 0095 0096 0097 0104 0108
  supabase migration repair --status reverted 20260604174218 20260605180954 20260606162651 20260606173937 20260606213859 20260610074150 20260616034648 20260618061210
  supabase migration list   # verify: clean 0001..0108, no strays
  ```
  (If pushing via MCP instead, do the equivalent with two `execute_sql` statements: INSERT the 8 numeric rows, DELETE the 8 timestamped rows — same confirmation first.)
- `npm run db:types` after every migration (trigger-only migrations produce an empty diff — that's expected).

### 0.3 Repo conventions the executor must follow

- Server actions return `{ ok: true, … } | { ok: false, error: string }`; on DB error: `return { ok: false, error: translatePgError(error) }` immediately, never audit a failed write.
- Audit every successful write: `audit({ actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent })`; ip/ua via `ipAndAgent()` from `src/lib/server/action-helpers.ts` (preferred) or the inline `x-forwarded-for` pattern already in the touched file.
- Custom PG error codes: next free are **P0016, P0036, P0040+**. Any new code gets a case in `src/lib/accounting/pg-errors.ts`. The two release gates use `errcode='check_violation'` (23514) + message-text matching (`/payment_status/i`, `/consent/i`) — new release-path trigger errors should follow THAT convention if they must be distinguished by `translatePgError`.
- Trigger-side audit rows: `actor_type = 'system'` (or `'staff'` when a staff FK is on the row), `jsonb_build_object(…)` metadata — model on 0064's `coa.suspense_post` rows.
- Reversal-JE pattern (canonical, copy exactly): insert `journal_entries` with `source_kind='reversal', source_id=null, reverses=<orig>` as `'draft'`, mirror `journal_lines` with debit/credit swapped, flip reversal to `'posted'`, flip original to `'reversed', reversed_by=<reversal>`.
- Conventional Commits. Branch names below. PRs via `gh` (`export PATH="/opt/homebrew/bin:$PATH"` first).
- Effort: **use high effort for every migration task** (marked ⚠ below). Sonnet subagents for everything else.

### 0.4 Branch / worktree model

Worktree `~/Claude/DRMed/.worktrees/release-lifecycle` (branch `feat/release-lifecycle`, = origin/main + the 4 docs commits). Per PR:

1. `git checkout -b <pr-branch>` from the current base (PR 1 branches off `feat/release-lifecycle` so the docs commits ride along; PRs 2+ branch off updated `origin/main` after the previous PR merges — re-verify anchors after each merge).
2. Implement → verify → push → `gh pr create` → **pause for user review**.
3. After merge: `git fetch origin && git checkout -b <next-branch> origin/main` in the same worktree.

### 0.5 Product decisions already made (do NOT re-open)

- Bulk release sends **one consolidated notification** per action (S2); single release keeps per-test notification; header auto-release sends nothing.
- `release_medium` ∈ {`physical`,`pickup`} ⇒ **skip email/SMS** on release notification (M7) — lands in PR 8.
- Undo release: any staff who can release; cascade to header; no time limit; loud viewed-warning.
- PR 9: if real-RLS wiring proves infeasible mid-implementation, **STOP and report** — no silent fallback.

---

# PR 1 — Feature 2: Released column in reception Queue

**Branch:** `feat/queue-released-column` (off `feat/release-lifecycle`, carries the docs commits into main)
**No migration.** Smallest PR; ships independently.

### Task 1.1: `releasedLabImagingNames()` helper (TDD)

**Files:**
- Modify: `src/lib/visits/queue-stage.ts` (78 lines)
- Test: `src/lib/visits/queue-stage.test.ts`

- [ ] **Step 1: Write the failing tests** — append to the existing file, mirroring its `test(overrides)` factory style:

```ts
describe("releasedLabImagingNames", () => {
  it("returns only released leaf lab/imaging test names", () => {
    const tests = [
      test({ status: "released", name: "CBC" }),
      test({ status: "released", section: "imaging_xray", name: "Chest X-ray" }),
      test({ status: "ready_for_release", name: "FBS" }),
      test({ status: "released", is_package_header: true, name: "ROUTINE PACKAGE" }),
      test({ status: "released", section: null, name: "Consult" }),
    ];
    expect(releasedLabImagingNames(tests)).toEqual(["CBC", "Chest X-ray"]);
  });

  it("does NOT count cancelled tests as released (terminal ≠ released)", () => {
    const tests = [
      test({ status: "cancelled", name: "Urinalysis" }),
      test({ status: "released", name: "CBC" }),
    ];
    expect(releasedLabImagingNames(tests)).toEqual(["CBC"]);
  });

  it("falls back to a dash when a name is missing", () => {
    expect(releasedLabImagingNames([test({ status: "released", name: null })])).toEqual(["—"]);
  });
});
```
(⟨audit⟩ the cancelled case is mandatory — a "terminal" mirror would wrongly count cancelled.)

- [ ] **Step 2:** `npx vitest run src/lib/visits/queue-stage.test.ts` → FAIL (`releasedLabImagingNames` not exported).
- [ ] **Step 3: Implement** — in `queue-stage.ts`, below `outstandingLabImagingNames`:

```ts
// Mirror of outstandingLabImagingNames for the queue's "Released" summary.
// Filters to EXACTLY status === 'released' (not "terminal": cancelled tests
// are terminal but must never be presented as released).
export function releasedLabImagingNames(
  tests: readonly QueueTestLike[],
): string[] {
  return tests
    .filter(
      (t) =>
        !t.is_package_header &&
        t.status === "released" &&
        t.section != null &&
        LAB_IMAGING_SECTIONS.has(t.section),
    )
    .map((t) => t.name ?? "—");
}
```

- [ ] **Step 4:** `npx vitest run src/lib/visits/queue-stage.test.ts` → PASS (all describe blocks).
- [ ] **Step 5:** Commit: `feat(queue): releasedLabImagingNames helper with cancelled-exclusion tests`

### Task 1.2: Render Released summary in Processing rows

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/queue/page.tsx` (428 lines)

- [ ] **Step 1:** Import `releasedLabImagingNames` next to the existing `outstandingLabImagingNames` import. Generalize `OutstandingSummary` (lines 285–303) into a shared name-list renderer and add a labeled Released line. Replace `OutstandingSummary` with:

```tsx
// Up-to-three names then "+N more" — shared by the Outstanding and Released
// summaries on Processing rows.
function NameSummary({ names }: { names: string[] }) {
  if (names.length === 0) return <span>—</span>;
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return (
    <span className="text-[color:var(--color-brand-text-mid)]">
      {shown.join(", ")}
      {extra > 0 ? (
        <span className="text-[color:var(--color-brand-text-soft)]"> +{extra} more</span>
      ) : null}
    </span>
  );
}

function ProcessingTestsSummary({ tests }: { tests: QueueTestLike[] }) {
  const outstanding = outstandingLabImagingNames(tests);
  const released = releasedLabImagingNames(tests);
  return (
    <div className="space-y-0.5">
      <p className="text-xs">
        <span className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Outstanding:{" "}
        </span>
        <NameSummary names={outstanding} />
      </p>
      <p className="text-xs">
        <span className="font-bold uppercase tracking-wider text-emerald-700">
          Released:{" "}
        </span>
        <NameSummary names={released} />
      </p>
    </div>
  );
}
```

- [ ] **Step 2:** Desktop `<QueueRow>` (lines 338–347): replace `<OutstandingSummary tests={entry.tests} />` with `<ProcessingTestsSummary tests={entry.tests} />`. Change the processing-stage column header (lines 213–215) from `"Outstanding"` to `"Outstanding / Released"`.
- [ ] **Step 3:** Mobile `<QueueCard>` (lines 389–396): replace the whole `stage === "processing" ? <p>…Outstanding…</p> : null` block with `{stage === "processing" ? <div className="mt-2"><ProcessingTestsSummary tests={entry.tests} /></div> : null}`.
- [ ] **Step 4:** Verify: `npm run typecheck && npm test && npm run build`. Then local smoke: `npm run dev`, open `/staff/visits/queue` as reception with a Processing visit that has ≥1 released test (seed via `npm run seed:test`, release one test in Studio or via the visit page as medtech) — both desktop table and narrow (390px) card show the two labeled lines.
- [ ] **Step 5:** Commit: `feat(queue): show Released tests summary on Processing rows` → push → `gh pr create` (title: `feat: Released column in reception Queue (release-lifecycle PR 1)`; body links spec Feature 2 + audit S4).
- [ ] **PAUSE — user review checkpoint.**

---

# PR 2 — Features 1+4: package release (per-component + bulk + header auto-release) + harmonized visit layout + S2/S3/H8

**Branch:** `feat/package-release` (off updated `origin/main`)
**Migration:** `0109_package_release_lifecycle.sql` ⚠ high effort

### Task 2.1 ⚠: Migration 0109 — restore bridge component guard + header auto-release (Legs A & B)

**Files:**
- Create: `supabase/migrations/0109_package_release_lifecycle.sql`

- [ ] **Step 1: Write the migration.** THREE parts. Part 1 re-creates BOTH bridge functions from their **live** definitions (pull with `pg_get_functiondef` against the local stack after `db reset` — local 0001..0108 lacks the legacy guard the prod fn has, so base the new text on the PROD def captured in §0.1 planning notes) with one added guard each, directly after the function's opening `begin`:

```sql
-- Part 1 — restore the 0041 component-skip guard dropped by 0064's rewrite.
-- Package components carry ₱0 prices; without this guard the released-bridge
-- creates a zero-line JE and je_status_balance_check aborts the release (P0003).
-- Verified against prod 2026-07-04: live fn has the legacy_import guard but NOT
-- this one. Full function bodies below are the live prod text + the guard.
create or replace function public.bridge_test_request_released() … as $$
…
begin
  -- Legacy backfill rows are GL-silent (the books already hold this money).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;
  -- Package components are ₱0 lines; the header books the package revenue (0041).
  if NEW.parent_id is not null then
    return NEW;
  end if;
  …rest of live body unchanged…
$$;

create or replace function public.bridge_test_request_cancelled() … as $$
begin
  -- Package components have no JE to reverse (see released-bridge guard).
  if NEW.parent_id is not null then
    return NEW;
  end if;
  …rest of live body unchanged…
$$;
```

Part 2 — Leg A (component terminal ⇒ header release), mirroring `fn_set_package_completed_at`'s proven count-pending shape (AFTER ROW triggers run post-statement, so same-statement bulk sibling updates are visible — the multi-row `.in()` release path works):

```sql
-- Part 2 — Leg A: when the last component goes terminal (≥1 released) on a
-- paid/waived visit, auto-release the header. The header UPDATE then flows
-- through the existing stack: payment gate (passes — pre-checked), consent
-- gate (passes — same visit, same txn as the component that just released),
-- bridge (books package revenue), 0042 (stamps package_completed_at).
create or replace function public.fn_release_header_when_components_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending  int;
  v_released int;
  v_paystat  text;
begin
  if new.parent_id is null then return new; end if;
  if new.status not in ('released', 'cancelled') then return new; end if;
  if old.status = new.status then return new; end if;

  select count(*) filter (where status not in ('released','cancelled')),
         count(*) filter (where status = 'released')
    into v_pending, v_released
    from public.test_requests
    where parent_id = new.parent_id;

  -- A fully-cancelled package (0 released) must NOT release — the cascade-
  -- cancel trigger (0040) owns that path.
  if v_pending > 0 or v_released = 0 then return new; end if;

  select payment_status into v_paystat
    from public.visits where id = new.visit_id;
  if v_paystat not in ('paid','waived') then return new; end if;

  update public.test_requests
     set status         = 'released',
         released_at    = now(),
         released_by    = auth.uid(),   -- nullable; null under service-role (0064 precedent)
         release_medium = 'other'
   where id = new.parent_id
     and status = 'ready_for_release';  -- idempotent across sibling triggers

  return new;
end;
$$;

create trigger tg_release_header_when_components_done
  after update of status on public.test_requests
  for each row execute function public.fn_release_header_when_components_done();
```

Part 3 — Leg B (visit becomes paid/waived ⇒ release ready headers whose components are already done). The header UPDATE is wrapped in an exception handler: Leg B fires from inside `recalc_visit_payment` (a payment INSERT) — a consent-gate rejection here must degrade to "header stays ready", never abort the payment:

```sql
-- Part 3 — Leg B: same check when the visit flips to paid/waived.
create or replace function public.fn_release_headers_on_visit_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h record;
begin
  for h in
    select th.id
      from public.test_requests th
     where th.visit_id = new.id
       and th.is_package_header
       and th.status = 'ready_for_release'
       and exists (select 1 from public.test_requests c
                    where c.parent_id = th.id and c.status = 'released')
       and not exists (select 1 from public.test_requests c
                        where c.parent_id = th.id
                          and c.status not in ('released','cancelled'))
  loop
    begin
      update public.test_requests
         set status = 'released', released_at = now(),
             released_by = auth.uid(), release_medium = 'other'
       where id = h.id and status = 'ready_for_release';
    exception when check_violation then
      -- Consent gate can legitimately reject here (withdrawn since the
      -- components released). Never abort the payment that triggered us;
      -- the header stays ready_for_release and releases on the next
      -- component re-release (Leg A) or manual action.
      null;
    end;
  end loop;
  return new;
end;
$$;

create trigger tg_release_headers_on_visit_paid
  after update of payment_status on public.visits
  for each row
  when (new.payment_status in ('paid','waived')
        and old.payment_status is distinct from new.payment_status)
  execute function public.fn_release_headers_on_visit_paid();
```

(The executor writes the FULL function bodies for Part 1 — copy the live prod definitions verbatim from `pg_get_functiondef` and add only the two guards. Do not retype from the 0064 file.)

- [ ] **Step 2: Local verification runbook** — `supabase start && supabase db reset`, then via `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres` (or Studio SQL editor) run a scripted scenario and assert each numbered expectation:
  1. Seed: create patient, visit (unpaid), package header + 3 components (`parent_id` set), plus 1 standalone test — mirror #0037's shape. (Reuse `npm run seed:test` + manual inserts; header `final_price_php = 500`, components 0.)
  2. Release a component while unpaid ⇒ payment-gate exception (23514, message contains `payment_status`). Header untouched.
  3. Insert a payment covering total ⇒ `recalc_visit_payment` flips visit to `paid`. (Leg B: header still `ready_for_release` because components aren't terminal — assert.)
  4. Release components 1 and 2 individually ⇒ each succeeds, **no JE for components** (guard), header still `ready_for_release`.
  5. Release component 3 ⇒ Leg A fires: header `released`, `release_medium='other'`, `package_completed_at` stamped (0042), exactly ONE posted JE with `source_kind='test_request', source_id=<header>` booking 500. `journal_lines` balanced.
  6. Fresh package on a PAID visit: single-statement bulk `update test_requests set status='released', … where parent_id=<h2> and status='ready_for_release'` ⇒ header auto-releases (same-statement tolerance).
  7. Fresh package, cancel ALL components ⇒ header does NOT release (stays per 0040 cascade semantics).
  8. Fresh package on UNPAID visit, release attempts blocked; cancel 1 of 3, release 2 blocked (unpaid) — then pay the visit ⇒ Leg B releases the header only after remaining components released… (assert Leg B does nothing while a component is pending, and fires when components were already terminal pre-payment: build one package with all components released? impossible while unpaid — instead: components cancelled×2 + … skip; the payment-before-terminal ordering is covered by 3+5). Instead assert Leg B directly: package with all 3 components CANCELLED and 0 released on unpaid visit → pay ⇒ header NOT released (≥1-released rule).
  9. `select * from journal_entries where status='posted' and source_kind='test_request'` ⇒ only header JEs; `journal_entries_one_posted_per_source` intact.
- [ ] **Step 3:** `npm run db:types` (expect empty/no-op diff — trigger-only), `npm test`, `npm run typecheck`.
- [ ] **Step 4:** Commit: `feat(db): package header auto-release (legs A+B) + restore bridge component guard`

### Task 2.2: Bulk-release server action + consolidated notification (S2) + Sentry in notifiers (H8)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`
- Create: `src/lib/notifications/notify-released-bulk.ts`
- Modify: `src/lib/notifications/notify-released.ts`, `notify-appointment-booked.ts`, `notify-appointment-reminder.ts`
- Modify: `src/lib/emails-log/types.ts`, `parse-row.ts` (+ `page.tsx` detail render if needed)

- [ ] **Step 1: `releaseAllReadyComponentsAction`** — add to `visits/[id]/actions.ts` below `releaseTestAction`, same conventions:

```ts
export async function releaseAllReadyComponentsAction(
  headerId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<ReleaseResult> {
  if (!VALID_MEDIA.includes(releaseMedium)) {
    return { ok: false, error: "Invalid release medium." };
  }
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // Verify the target really is a package header on this visit.
  const { data: header } = await supabase
    .from("test_requests")
    .select("id, is_package_header, visit_id")
    .eq("id", headerId)
    .eq("visit_id", visitId)
    .maybeSingle();
  if (!header?.is_package_header) {
    return { ok: false, error: "Package not found on this visit." };
  }

  const now = new Date().toISOString();
  // Single user-scoped UPDATE: per-row payment/consent triggers still enforce
  // the gates; the header then auto-releases via the Leg A trigger.
  const { data: released, error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
    })
    .eq("parent_id", headerId)
    .eq("status", "ready_for_release")
    .select("id, services ( name )");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!released || released.length === 0) {
    return { ok: false, error: "No components are ready to release." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  // One audit row per released component (per-release convention), bulk-tagged.
  for (const row of released) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.released",
      resource_type: "test_request",
      resource_id: row.id,
      metadata: { visit_id: visitId, release_medium: releaseMedium, bulk: true },
      ip_address: ip,
      user_agent: ua,
    });
  }

  // S2: ONE consolidated notification for the whole bulk action.
  try {
    await notifyResultsReleasedBulk({
      visitId,
      testRequestIds: released.map((r) => r.id),
      testNames: released.map((r) => serviceName(r.services) ?? "Result"),
    });
  } catch (err) {
    await reportError({
      scope: "notify/result-released-bulk",
      error: err,
      metadata: { visit_id: visitId, header_id: headerId },
    });
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
```
(`serviceName()` = the file's existing object-or-array services flattener; add a small local helper if none exists. Import `reportError` from `@/lib/observability/report-error` and `notifyResultsReleasedBulk`.)

- [ ] **Step 2: `notify-released-bulk.ts`** — new notifier, structure cloned from `notify-released.ts` (fetch visit → patient; build email with `renderEmailShell`; SMS text "N results from your DRMed visit are ready…"; `Promise.all`; audit). Key differences:
  - Input: `{ visitId, testRequestIds, testNames }`.
  - Email heading `"Your lab results are ready"`, paragraph "**N results** from your visit have been released…", `emailDetailBox` rows = up to 6 test names (then "+N more"), then the standard DRM-ID/PIN box, portal button, fine print, optional review CTA (reuse `patientAlreadyAskedForReview`).
  - **Audit metadata MUST keep the `sms`/`email` sub-objects with `ok`/`skipped`/`error` keys** (admin emails-sent filters depend on the JSONB paths) and add `bulk: true, count, test_names, test_request_ids` — action stays `"result.notified"`, `resource_type: "test_request"`, `resource_id: testRequestIds[0]`.
- [ ] **Step 3: emails-sent page bulk rendering** — in `src/lib/emails-log/parse-row.ts`, where `detail = asString(meta.test_name)` (≈line 82): fall back to `meta.bulk === true ? \`${meta.count ?? "?"} results ready\` : null`. Extend `types.ts` if the row type needs the field. Verify the admin page shows a sensible Details cell for a bulk row.
- [ ] **Step 4: H8 — `reportError()` in all three notifiers.** In each of `notify-released.ts`, `notify-appointment-booked.ts`, `notify-appointment-reminder.ts` (and the new bulk notifier), after the send results are known, for each `kind === "error"` result add:

```ts
if (!smsResult.ok && smsResult.kind === "error") {
  await reportError({
    scope: "notify/result-released:sms",
    error: new Error(smsResult.error),
    metadata: { test_request_id: testRequestId, visit_id: visitId },
  });
}
```
(mirror for email; adjust scope string per notifier; NEVER report `kind === "skipped"`). Also in `releaseTestAction`'s existing catch, replace `console.error("notifyResultReleased threw", err)` with `await reportError({ scope: "notify/result-released", error: err, metadata: { test_request_id: testRequestId } })`.

- [ ] **Step 5:** `npm run typecheck && npm test`. Commit: `feat(release): bulk component release + consolidated notification + Sentry on notifier failures`

### Task 2.3: Harmonized visit layout (Feature 4) + release UI (Feature 1)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx` (870 lines; `TestAction` is inline at lines 774–870)
- Create: `src/app/(staff)/staff/(dashboard)/visits/[id]/release-all-button.tsx`

- [ ] **Step 1: `ReleaseAllButton` client component** — clone `release-button.tsx`'s structure (same `MEDIUM_OPTIONS`, `useState(preferredMedium ?? "physical")`, `useTransition`, disabled/`title` logic for `!paid` / consent-block); props `{ headerId, visitId, paid, preferredMedium, consentOnFile, gateRequired, readyCount }`; button label `Release all ready (N)`; calls `releaseAllReadyComponentsAction(headerId, visitId, medium)`; `alert(result.error)` on failure.
- [ ] **Step 2: `TestAction` compact variant** — add `size?: "default" | "compact"` prop (string-union precedent: `single-claim-actions.tsx`); thread a `sizeCls` into its rendered buttons/text (`text-[10px] min-h-[28px]` compact vs current). `ReleaseButton` gets the same optional prop, default `"default"`.
- [ ] **Step 3: Section headings** — under the "Tests" heading: render `<h3>Packages</h3>` before the package cards (only when ≥1 header) and `<h3>Individual tests</h3>` before the standalone table (only when ≥1 standalone; keep the existing empty-state copy). Match the page's existing heading classes.
- [ ] **Step 4: Component rows adopt the table grammar** — rework the package card's component `<ul>` (lines ~390–443) into rows with the table's rhythm: same row height/padding + grid columns aligned to Service | Base | Discount | Final | Status | Action; components render "—" in the three price cells; status badge in the same position/classes as the table; right-aligned Action cell rendering `<TestAction size="compact" …same props as the table build… />`. Mobile: the same responsive stacking the standalone table rows use (no divergent mobile treatment).
  - **Reception note (pre-existing behavior, keep):** `sectionsForRole("reception") = []` filters all test rows — reception continues to see no test rows/cards; do not loosen the gate in this PR.
- [ ] **Step 5: Header row controls** — on the package card header row, right side (mirroring the table's Action column): when the visit-page data shows ≥2 components at `ready_for_release`, render `<ReleaseAllButton …/>`; when exactly 1, that component's own row button suffices (render nothing on the header).
- [ ] **Step 6: Verify** — `npm run typecheck && npm run build`; local smoke on seeded #0037-shaped visit: per-component Release works (row button), bulk button releases all ready + header auto-releases (badge flips, Completed date appears, PDF links intact), unpaid visit shows disabled buttons with title, page reads as one system at desktop + 390px.
- [ ] **Step 7:** Commit: `feat(visits): harmonized package/singles layout + per-component and bulk release UI`

### Task 2.4: PR 2 wrap-up + deploy + post-deploy operational step (S3)

- [ ] **Step 1:** Full check: `npm test && npm run typecheck && npm run build`. Push, `gh pr create` (`feat: package release + harmonized visit layout (release-lifecycle PR 2)`).
- [ ] **PAUSE — user review checkpoint (code).**
- [ ] **Step 2 (after approval): remote migration push** — run §0.2's one-time repair first, then apply 0109 via MCP `execute_sql` + manual `schema_migrations` insert (version `'0109'`). Verify with `supabase migration list` + live smoke-read (`pg_get_functiondef` of the two bridges shows the guard; triggers exist).
- [ ] **PAUSE — confirm with user BEFORE the push (prod is the only remote).**
- [ ] **Step 3 (S3, human-in-the-loop):** after Vercel deploy, the USER releases the three stuck packages through the new UI: #0037 (paid → releases now), #0032/#0039 (stay gated until paid). Verify #0037: header released, JE posted, patient portal shows consolidated download, ONE consolidated notification row in admin emails-sent.

---

# PR 3 — Feature 3: undo release + re-release

**Branch:** `feat/undo-release` (off updated `origin/main`)
**Migration:** `0110_undo_release.sql` ⚠ high effort

### Task 3.1 ⚠: Migration 0110 — undo-release trigger (reversal + package cascade)

**Files:**
- Create: `supabase/migrations/0110_undo_release.sql`

- [ ] **Step 1: Write the migration.** One function + trigger on the `released → ready_for_release` transition (no other code path produces it today — verified by the audit). The reversal body **duplicates** `bridge_test_request_cancelled`'s pattern with a header comment cross-referencing 0064 (spec allows duplicate-with-comment; do NOT refactor 0064's function in this migration):

```sql
-- Undo release: released → ready_for_release.
-- 1) Reverse the accounting exactly like bridge_test_request_cancelled (0064):
--    posted reversal JE (source_kind='reversal', reverses=original), original
--    → 'reversed', open doctor_pf_entries / cogs_send_out_entries soft-voided
--    with void_reason='release_undone'. Defensive no-JE branch: void subledger
--    rows only (covers ₱0 package components and legacy-import rows).
-- 2) Package cascade: a component undo clears the header's stamp and, if the
--    header is released, flips it back too — which re-fires this trigger for
--    the header's own JE reversal (recursion terminates: headers have no parent).
create or replace function public.fn_undo_release_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
  v_header       record;
begin
  v_actor := auth.uid();

  -- ---- 1. Accounting reversal (pattern: 0064 bridge_test_request_cancelled) --
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request' and source_id = new.id and status = 'posted'
    for update;

  if v_original_je is not null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, reverses, created_by
    ) values (
      current_date,
      'Reversal of ' || v_orig_number || ': release undone',
      'draft', 'reversal', null, v_original_je, v_actor
    ) returning id into v_reversal_je;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    select v_reversal_je, account_id, credit_php, debit_php, line_order
      from public.journal_lines where entry_id = v_original_je order by line_order;

    update public.journal_entries set status = 'posted' where id = v_reversal_je;
    update public.journal_entries
       set status = 'reversed', reversed_by = v_reversal_je
     where id = v_original_je;
  end if;

  update public.doctor_pf_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

  update public.cogs_send_out_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

  -- ---- 2. Package cascade ---------------------------------------------------
  if new.parent_id is not null then
    select id, status into v_header
      from public.test_requests where id = new.parent_id for update;

    -- Clear the completion stamp; fn_set_package_completed_at's IS NULL guard
    -- re-stamps correctly on re-completion.
    update public.test_requests
       set package_completed_at = null
     where id = new.parent_id and package_completed_at is not null;

    if v_header.status = 'released' then
      -- Re-fires this trigger for the header's own JE reversal.
      update public.test_requests
         set status = 'ready_for_release',
             released_at = null, released_by = null, release_medium = null
       where id = new.parent_id;

      -- Traceability: the human reason lives on the component's audit row
      -- (written by the server action); this system row marks the cascade.
      insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
      values (
        v_actor, 'system', 'test_request.release_undone', 'test_request', new.parent_id,
        jsonb_build_object('cascaded_from', new.id, 'visit_id', new.visit_id)
      );
    end if;
  end if;

  return new;
end;
$$;

create trigger tg_undo_release_bridge
  after update of status on public.test_requests
  for each row
  when (old.status = 'released' and new.status = 'ready_for_release')
  execute function public.fn_undo_release_bridge();
```

- [ ] **Step 2: Local runbook** (fresh `db reset`, extend the PR 2 scenario):
  1. Release a priced standalone test on a paid visit ⇒ posted JE. Undo (manual UPDATE) ⇒ original JE `reversed`, mirrored reversal posted, PF/COGS rows (if any) voided `release_undone`. Row sits `ready_for_release`, released_* nulls.
  2. Re-release ⇒ FRESH posted JE (idempotency guard passes: original is `reversed`); `journal_entries_one_posted_per_source` holds.
  3. Full package released (header auto-released via 2.1) ⇒ undo ONE component ⇒ component has no JE (defensive branch no-op), header flips to `ready_for_release`, header's JE reversed, `package_completed_at` cleared, system audit row present. Re-release the component ⇒ Leg A re-releases header, fresh header JE, stamp re-set.
  4. Undo on a consult line with PF accrual ⇒ `doctor_pf_entries` row voided + JE reversed.
  5. Assert no path yields a posted JE for an unreleased test (query the invariant).
- [ ] **Step 3:** `npm run db:types` (no-op expected) + `npm test`. Commit: `feat(db): undo-release trigger — JE reversal + package cascade`

### Task 3.2: `undoReleaseAction` + viewed-count union + metadata normalization (S1)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`
- Create: `src/lib/results/viewed-count.ts`
- Modify: `src/app/(patient)/portal/(authenticated)/actions.ts` (3 download-audit metadata writes)

- [ ] **Step 1: `undoReleaseAction(testRequestId, visitId, reason)`** — spec steps verbatim:

```ts
export type UndoReleaseResult = { ok: true } | { ok: false; error: string };

export async function undoReleaseAction(
  testRequestId: string,
  visitId: string,
  reason: string,
): Promise<UndoReleaseResult> {
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, error: "Reason is required." };
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const { data: tr } = await supabase
    .from("test_requests")
    .select("id, status, is_package_header, released_at, release_medium")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .maybeSingle();
  if (!tr) return { ok: false, error: "Test not found on this visit." };
  // LOAD-BEARING guard (audit): nothing else blocks a direct header
  // released→ready_for_release; the undo trigger itself cannot (its own
  // cascade legitimately produces that transition).
  if (tr.is_package_header) {
    return { ok: false, error: "Undo the package's components instead — the header follows them." };
  }
  if (tr.status !== "released") {
    return { ok: false, error: "Only released results can be undone." };
  }

  const { error } = await supabase
    .from("test_requests")
    .update({ status: "ready_for_release", released_at: null, released_by: null, release_medium: null })
    .eq("id", testRequestId)
    .eq("status", "released");
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.release_undone",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: visitId,
      reason: trimmed,
      prior_release_medium: tr.release_medium,
      prior_released_at: tr.released_at,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
```

- [ ] **Step 2: viewed-count union helper** (`src/lib/results/viewed-count.ts`, `import "server-only"`; admin client — audit rows are admin-read). The three metadata shapes are NOT disjoint on `resource_id` (single-test rows also carry `resource_id = results.id`), so union by audit-row id:

```ts
// 3-way union (audit S1): result.downloaded rows reference a test_request via
// (1) metadata.test_request_id, (2) resource_id = a results.id linked through
// result_test_requests, or (3) metadata.merged_component_ids containing it.
// Shapes overlap — dedupe by audit row id.
export async function countResultViews(testRequestId: string): Promise<number> {
  const admin = createAdminClient();
  const ids = new Set<number>();

  const base = () =>
    admin.from("audit_log").select("id")
      .eq("action", "result.downloaded").eq("resource_type", "result");

  const [byMeta, links, byMerged] = await Promise.all([
    base().eq("metadata->>test_request_id", testRequestId),
    admin.from("result_test_requests").select("result_id").eq("test_request_id", testRequestId),
    base().contains("metadata->merged_component_ids", JSON.stringify([testRequestId])),
  ]);
  byMeta.data?.forEach((r) => ids.add(r.id));
  byMerged.data?.forEach((r) => ids.add(r.id));

  const resultIds = links.data?.map((l) => l.result_id) ?? [];
  if (resultIds.length > 0) {
    const { data } = await base().in("resource_id", resultIds);
    data?.forEach((r) => ids.add(r.id));
  }
  // New rows also carry metadata.test_request_ids (normalized going forward).
  const { data: byNorm } = await base().contains("metadata->test_request_ids", JSON.stringify([testRequestId]));
  byNorm?.forEach((r) => ids.add(r.id));

  return ids.size;
}
```
(Verify the exact supabase-js JSONB-contains call form compiles — `.contains("metadata->merged_component_ids", …)` — adjust to `.filter(col, "cs", …)` if needed.)

- [ ] **Step 3: normalize the three download writers** — in `portal/(authenticated)/actions.ts`, add `test_request_ids` (string[] covering every component involved) to each `result.downloaded` metadata: single-test `[testRequestId]`; report-group = all `test_request_id`s linked to the result (already fetched in that flow); package = `releasedComponents.map(c => c.id)` (keep `merged_component_ids` too for historical-query compatibility).
- [ ] **Step 4:** `npm run typecheck && npm test`. Commit: `feat(release): undoReleaseAction + patient-viewed union count + download metadata normalization`

### Task 3.3: Undo UI (dialog + TestAction wiring)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/visits/[id]/undo-release-dialog.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`

- [ ] **Step 1: `UndoReleaseDialog`** — copy `void-payment-dialog.tsx`'s EXACT pattern (inline expand; validate-on-click with literal `"Reason is required."`; Confirm disabled only while pending; Cancel resets). Props `{ testRequestId, visitId, viewedCount }`. Trigger: small `Undo` link-button. Expanded panel copy: "This result will be pulled from the patient portal and the release accounting reversed. Re-releasing later is allowed. Reason is audit-logged." When `viewedCount > 0`, prominent amber block: `Patient has already viewed/downloaded this result {viewedCount} time(s) — undoing does not un-see it.` Calls `undoReleaseAction(testRequestId, visitId, reason.trim())`.
- [ ] **Step 2: wire into `TestAction`** — the `"released"` branch renders `Released ✓` (+ PDF link) **+ `<UndoReleaseDialog …/>`** for BOTH standalone tests and package component rows (and consults — same branch). New `TestAction` prop `viewedCount: number`. The page (server component) computes counts: collect released test ids on the page, `await Promise.all(ids.map(countResultViews))` → map (no client-side audit query). Package headers get NO undo affordance (server guard + simply don't render the dialog for header rows).
- [ ] **Step 3: verify** — typecheck/build; local smoke: undo standalone (dialog validates blank reason inline, JE reverses, ReleaseButton reappears — re-release works with fresh JE + re-notification), undo component under released header (header reverts, its JE reversed), viewed-warning shows after downloading via portal.
- [ ] **Step 4:** Commit → push → `gh pr create` (`feat: undo release with reason + re-release (release-lifecycle PR 3)`).
- [ ] **PAUSE — user review; then remote push of 0110 (MCP + version insert `'0110'`), pausing again before the push.**

---

# PR 4 — Feature 5: admin undone-releases report

**Branch:** `feat/undone-releases-report` (off updated `origin/main`). **No migration.**

### Task 4.1: Report page + nav entry

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/reports/undone-releases/page.tsx`
- Modify: `src/components/staff/staff-nav-config.ts` (Books & reports subgroup, next to lab-tat ≈line 337)

- [ ] **Step 1: page** — model on `admin/reports/lab-tat/page.tsx` (metadata, `force-dynamic`, `requireAdminStaff()`, GET-form date filter with `DATE_RE` validation) + `staff-advances`' 500-row cap. Data:
  - `audit_log` via admin client: `action = 'test_request.release_undone'`, `created_at` within range (default last 90 days), `.order("created_at", {ascending: false}).limit(500)`; note when 500 hit: "Showing the most recent 500 — narrow the range."
  - Staff undos: `actor_type='staff'` (reason in metadata); cascade rows: `actor_type='system'` (metadata.cascaded_from) — render "System (package cascade)" in the Undone-by column.
  - Join current outcome: fetch the referenced `test_requests` (`.in("id", resourceIds)` with `status, released_at, visit_id, services(name, code), visits(visit_number, patients(first_name, last_name, drm_id))`) → outcome = `released` ⇒ "Re-released {date}", `ready_for_release` ⇒ "Still unreleased", `cancelled` ⇒ "Cancelled".
  - Columns: When (Manila, `Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", … })` matching lab-tat's date rendering), Patient (name + DRM-ID), Visit #, Test (name/code), Undone by (staff name via `staff_profiles` lookup of actor_id), Reason, Current outcome.
- [ ] **Step 2: nav** — Books & reports item: `{ href: "/staff/admin/reports/undone-releases", label: "Undone releases", description: "Every result release that was withdrawn — who undid it, why, whether the patient had already seen it, and whether it has since been re-released or cancelled (RA 10173 oversight).", roles: ["admin"] }`.
- [ ] **Step 3:** typecheck/build; smoke with PR 3's local undo data (both staff + system rows render; outcomes correct; range filter works; mobile `overflow-x-auto`).
- [ ] **Step 4:** Commit → PR (`feat: admin undone-releases report (release-lifecycle PR 4)`). **PAUSE — user review.**

---

# PR 5 — Payments integrity (H4, H3, M10, skill-doc fix)

**Branch:** `fix/payments-integrity` (off updated `origin/main`)
**Migration:** `0111_payment_void_recalc.sql` ⚠ high effort

### Task 5.1 ⚠: Migration 0111 — recalc on void + voided-filter

**Files:**
- Create: `supabase/migrations/0111_payment_void_recalc.sql`

- [ ] **Step 1:**

```sql
-- H4: recalc_visit_payment (0001) fires only on INSERT and its SUM includes
-- voided rows — a fully-refunded visit stays 'paid' forever and the release
-- gate keeps passing. Fix both: filter voided rows in the SUM, and fire the
-- recalc on the void UPDATE (same WHEN shape as trg_bridge_payment_void, 0030).
create or replace function public.recalc_visit_payment()
returns trigger
language plpgsql
as $$
declare
  v_total numeric(10,2);
  v_paid  numeric(10,2);
  v_calculated_status text;
begin
  select total_php into v_total
  from public.visits where id = new.visit_id for update;

  select coalesce(sum(amount_php), 0) into v_paid
  from public.payments
  where visit_id = new.visit_id
    and voided_at is null;          -- H4: voided payments no longer count

  if v_total = 0 or v_paid >= v_total then
    v_calculated_status := 'paid';
  elsif v_paid > 0 then
    v_calculated_status := 'partial';
  else
    v_calculated_status := 'unpaid';
  end if;

  update public.visits
  set paid_php = v_paid,
      payment_status = case
        when payment_status = 'waived' then 'waived'   -- preserved on void too
        else v_calculated_status
      end,
      updated_at = now()
  where id = new.visit_id;

  return new;
end;
$$;

create trigger trg_payments_recalc_on_void
  after update of voided_at on public.payments
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function public.recalc_visit_payment();
```

- [ ] **Step 2: local runbook** — `db reset`; visit ₱1000: pay ₱1000 ⇒ `paid`; void the payment ⇒ `paid_php=0`, status `unpaid`, reversal JE posted (0030 trigger still fires, order-independent); pay again ⇒ `paid` (fresh sum excludes the voided row); a WAIVED visit + void ⇒ stays `waived`. Regression: releasing on the re-paid visit works; releasing after full void is blocked by the payment gate.
- [ ] **Step 3:** `npm run db:types` (no-op) + `npm test`. Commit: `fix(db): payment void recalculates visit payment status; sum excludes voided rows`

### Task 5.2: Waive-balance action + dialog (H3)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/visits/[id]/waive-balance-dialog.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`, `page.tsx`
- Modify: `src/lib/validations/accounting.ts` (WaiveBalanceSchema next to VoidPaymentSchema)

- [ ] **Step 1: schema** — `export const WaiveBalanceSchema = z.object({ reason: z.string().trim().min(1, "Reason is required.").max(500) });`
- [ ] **Step 2: action** — `waiveVisitBalanceAction(visitId, reason)` in `visits/[id]/actions.ts`: `requireAdminStaff()`; read visit (`payment_status, total_php, paid_php`); guard `payment_status` ∈ {`unpaid`,`partial`} (already paid/waived ⇒ friendly error); user-scoped `.update({ payment_status: "waived" }).eq("id", visitId).in("payment_status", ["unpaid","partial"])` (`'waived'` is the one legitimate manual write — hard-rule exception; `recalc_visit_payment` preserves it thereafter, **and Leg B (0109) then auto-releases any all-terminal package headers — that is the point: H3 unblocks Feature 1 for HMO/zero-balance visits**); on error `translatePgError`; audit `action: "payment.waived"`, `resource_type: "visit"`, `resource_id: visitId`, metadata `{ reason, previous_status, balance_waived_php: total - paid }` with `ipAndAgent()`; `revalidatePath`.
- [ ] **Step 3: dialog** — `WaiveBalanceDialog` copies `void-payment-dialog.tsx` verbatim-pattern (inline expand, validate-on-click `"Reason is required."`, pending-only disable). Trigger button: `Waive balance` . Panel copy: "Marks this visit as waived (HMO-covered / charity / no-charge). Results become releasable without payment. Reason is audit-logged."
- [ ] **Step 4: page wiring** — in the summary section (visit page lines ~277–299), next to the Status badge: `{isAdmin && !isPaid ? <WaiveBalanceDialog visitId={visit.id} balanceLabel={…} /> : null}`.
- [ ] **Step 5: verify** — typecheck/build; local: waive an unpaid visit as admin ⇒ badge flips to "Waived", ReleaseButtons enable, package header auto-releases when components were already terminal (Leg B); reception sees no waive control; second waive attempt ⇒ friendly error.
- [ ] **Step 6:** Commit: `feat(payments): admin waive-balance action (HMO/zero-balance releases)`

### Task 5.3: translatePgError routing (M10) + skill-doc correction

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/payments/new/actions.ts` (lines 55, 157, 175)
- Modify: `.claude/skills/drmed-payments/SKILL.md` (lines 42–51)

- [ ] **Step 1:** import `translatePgError`; replace the three raw-message returns: line 55 `error?.message ?? "Could not record payment."` → `error ? translatePgError(error) : "Could not record payment."`; line 157 same for `payErr`; line 175 `updErr.message` → `translatePgError(updErr)`. (Business-logic errors — code not found / already paid — stay as-is.)
- [ ] **Step 2:** SKILL.md: fix the stale recalc bullet to "Sums `payments.amount_php WHERE visit_id=… AND voided_at IS NULL` **(filter added in 0111; before that the sum included voided rows)**" and change "AFTER INSERT on `payments`" to "AFTER INSERT, and AFTER UPDATE OF voided_at when voiding (0111)". Add `payment.waived` to the actions table.
- [ ] **Step 3:** `npm test && npm run typecheck && npm run build`. Commit → PR (`fix: payments integrity — void recalc, waive balance, error translation (PR 5)`).
- [ ] **PAUSE — user review; then 0111 remote push (MCP + `'0111'` version insert), pausing before the push.**

---

# PR 6 — Lab queue operations (H5, H1-guard, M8, stuck-tests report)

**Branch:** `fix/lab-queue-operations` (off updated `origin/main`). **No migration** (critical-alerts ack RLS already exists; all changes are app-code).

### Task 6.1: Admin unclaim/reassign (H5a)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/queue/[id]/reassign-panel.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx`, `queue/page.tsx`

- [ ] **Step 1: actions** — two admin actions in `queue/actions.ts`:

```ts
export async function unclaimTestAction(testRequestId: string): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  const supabase = await createClient();
  // Only an in-flight claim with no uploaded result can be unclaimed.
  const { data, error } = await supabase
    .from("test_requests")
    .update({ status: "requested", assigned_to: null, started_at: null })
    .eq("id", testRequestId)
    .eq("status", "in_progress")
    .not("assigned_to", "is", null)
    .select("id, visit_id, assigned_to")
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) return { ok: false, error: "Only claimed, in-progress tests can be unclaimed." };
  // audit: action "test_request.unclaimed", metadata { visit_id, previous_assignee }
  // (same audit/ip/ua shape as claimTestAction), revalidatePaths, return { ok: true }
}

export async function reassignTestAction(testRequestId: string, newAssigneeId: string): Promise<ClaimResult> {
  const session = await requireAdminStaff();
  // verify newAssigneeId is an ACTIVE staff_profiles row with a lab-capable role
  // (medtech | xray_technician | pathologist | admin); friendly error otherwise.
  // update: .update({ assigned_to: newAssigneeId }).eq("id", id)
  //         .in("status", ["in_progress", "result_uploaded"])
  //         .select(...).maybeSingle() — row-count check like claimTestAction.
  // audit: "test_request.reassigned", metadata { visit_id, from, to }.
}
```
(Executor fills the elided audit/verify blocks by copying `claimTestAction`'s tail verbatim; `requireAdminStaff` import from `@/lib/auth/require-admin`.)

- [ ] **Step 2: detail-page panel** — `ReassignPanel` client component (admin-only render): shows current assignee name, `Unclaim` button (confirm via the VoidPaymentDialog inline-expand pattern, reason optional → metadata), and a `<select>` of active lab staff (page passes the list: `staff_profiles` where `active` and role in lab roles) + `Reassign` button. Render in `queue/[id]/page.tsx`'s Timing/assignment section when `session.role === "admin"` and `test.assigned_to` is set.
- [ ] **Step 3: queue list** — for admins, show "Claimed by {name}" on in-progress cards (page already selects `assigned_to`; join staff names via one `.in("user_id", ids)` on `staff_profiles`).
- [ ] **Step 4:** typecheck/build + local smoke (admin unclaims a stuck claim ⇒ test back in queue, another medtech claims it; reassign moves entry rights — result entry accepts the new assignee, rejects the old one). Commit: `feat(queue): admin unclaim/reassign for stuck claims`

### Task 6.2: Consolidated-flow fixes (H5b/c)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts`
- Modify: `src/lib/actions/results/finalise-consolidated.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx`

- [ ] **Step 1: claim guard** — in `claimConsolidated`: change the update to `.eq("status", "requested")` (drop `in_progress` from the allowed-from set), add `started_at: new Date().toISOString()`, add `.select("id")` and reject when `data.length !== testRequestIds.length`:
  `return { ok: false, error: "Some tests in this report were already claimed or changed status." }` (matching `claimTestAction`'s semantics). Change the audit action string `"test_request.claim"` → `"test_request.claimed"` (keep `grouped: true` metadata).
- [ ] **Step 2: ownership check in `finaliseConsolidatedReport`** — before writing anything: fetch `assigned_to` for all `input.testRequestIds`; if any row's `assigned_to !== session.user_id` → `return { ok: false, error: "You haven't claimed this report." }` (mirrors `prepareStructured`'s check; note admin gets no bypass — same as the single-test flow; admins use Task 6.1 reassign).
- [ ] **Step 3: thread releaseDeferred** — change the type:

```ts
export type FinaliseResult =
  | { ok: true; data: { result_id: string; releaseDeferred: boolean; deferredReason: "payment" | "consent" | null } }
  | { ok: false; error: string };
```
populate from the existing local vars. In `consolidated-form.tsx`'s `handleFinalise`: on success with `releaseDeferred`, do NOT navigate immediately — set state rendering an amber banner: `Report finalised — release deferred: {reason === "payment" ? "visit not yet paid; results release automatically once payment is recorded" : "patient consent not on file"}` with a "Back to queue" button; without deferral keep the current `router.push("/staff/queue")`.
- [ ] **Step 4:** typecheck + local smoke: two-tab steal attempt now fails with the already-claimed error; finalise by non-claimer rejected; finalise on unpaid visit shows the deferred banner (and — via 0109 Leg B — releases by itself when payment lands). Commit: `fix(queue): consolidated flow — claim race guard, ownership check, visible deferred release`

### Task 6.3: Guard the requires_signoff toggle (H1) + critical-alert acknowledge (M8)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/services/service-form.tsx` (lines 382–399)
- Create: `src/app/(staff)/staff/(dashboard)/critical-alerts/page.tsx`, `acknowledge-button.tsx`, `actions.ts`
- Modify: `src/components/staff/staff-nav-config.ts`, `src/components/staff/notification-bell.tsx`

- [ ] **Step 1: toggle guard** — in `service-form.tsx`, make the `requires_signoff` checkbox `disabled` with `defaultChecked={initial?.requires_signoff ?? false}` preserved, add a hidden input carrying the current value (so edits don't silently clear it), and a sub-note (matching the file's `<span className="block text-xs …">` pattern): `The pathologist sign-off queue isn't built yet — flipping this on would strand results at "awaiting sign-off" with no way forward. Locked until the sign-off queue ships.`
- [ ] **Step 2: acknowledge action** — `acknowledgeCriticalAlertAction(alertId)`: `requireActiveStaff()`, guard `role in ("pathologist","admin")` (friendly error otherwise; RLS backstops), user-scoped `.update({ acknowledged_at: now, acknowledged_by: session.user_id }).eq("id", alertId).is("acknowledged_at", null).select("id").maybeSingle()` (row-count = already-acked guard), audit `"critical_alert.acknowledged"` (`resource_type: "critical_alert"`, metadata `{ test_request_id, parameter_name }` from a pre-read), revalidate.
- [ ] **Step 3: unacked list page** — `/staff/critical-alerts`: `requireActiveStaff()` + render-403 for roles outside pathologist/admin; user-scoped select of `critical_alerts` `.is("acknowledged_at", null)` ordered desc, joined patient DRM-ID/name + parameter/direction/observed vs threshold + link to `/staff/queue/{test_request_id}` + `<AcknowledgeButton>` per row; recent-acknowledged collapsed `<details>` (last 50). Nav: add to the lab section for `["pathologist","admin"]` with description; also link the bell's critical items to this page (`notification-bell.tsx`: critical items' href stays the queue link — add a "View all critical alerts" footer link to `/staff/critical-alerts` when any critical item is present).
- [ ] **Step 4:** typecheck/build; local smoke: finalise a structured result crossing a critical threshold ⇒ row appears on the page; acknowledge ⇒ leaves unacked list, dashboard "Critical alerts unacked" count drops. Commit: `feat(lab): critical-alert acknowledge flow + guard unwired sign-off toggle`

### Task 6.4: Stuck-tests admin report

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/reports/stuck-tests/page.tsx`
- Modify: `src/components/staff/staff-nav-config.ts` (Books & reports)

- [ ] **Step 1:** page modeled on staff-advances (cap) + lab-tat (filters): `requireAdminStaff()`; threshold param `?days=` (default 3, GET form); admin-client query: `test_requests` where `status in ('requested','in_progress','result_uploaded','ready_for_release')` and `is_package_header = false` and `requested_at < now()-days` — `.order("requested_at").limit(500)` + cap notice; columns: Age (days, Manila), Visit #, Patient, Test, Status (badge), Claimed by (staff name or "—"), payment status of the visit (unpaid explains stuck ready_for_release), link to `/staff/queue/{id}` / visit. Also surface package HEADERS stuck `ready_for_release` on paid visits (the #0037 class) in a second small table: header rows where all components terminal, ≥1 released, visit paid — "should have auto-released; investigate" (post-0109 this should always be empty).
- [ ] **Step 2:** nav item (Books & reports): `{ href: "/staff/admin/reports/stuck-tests", label: "Stuck tests", description: "Tests sitting too long in any non-final state — unclaimed, in progress, or ready but unreleased — so nothing silently stalls like Visit #0037 did.", roles: ["admin"] }`.
- [ ] **Step 3:** typecheck/build + smoke with seeded data. Commit → PR (`feat: lab queue operations — reassign, race guards, alerts, stuck-tests report (PR 6)`). **PAUSE — user review.**

---

# PR 7 — Booking + registration hardening (H6, M1, M4, M5, M10)

**Branch:** `fix/booking-hardening` (off updated `origin/main`)
**Migration:** `0112_booking_hardening.sql` ⚠ high effort

> **⚠ Plan deviation to confirm at review:** audit §8 prescribes a partial unique
> index on `(physician_id, scheduled_at)`. That index would break (a) physicians
> with `allow_concurrent = true` (legitimately N bookings/slot) and (b)
> multi-service doctor bookings (one row per service, same physician+slot within
> one booking_group). This plan instead delivers the audit's alternative fix
> direction — a SECURITY DEFINER RPC with a per-slot advisory lock that honors
> `allow_concurrent` — plus the policy tightening. Confirm at PR-7 review; if the
> user prefers the literal index, scope it `WHERE NOT allow_concurrent…` is not
> expressible per-table — the RPC is the correct shape.

### Task 7.1 ⚠: Migration 0112 — INSERT-policy tightening + guarded booking/resolve RPCs

**Files:**
- Create: `supabase/migrations/0112_booking_hardening.sql`

- [ ] **Step 1:**

```sql
-- H6a: the public INSERT policy (0001) was with_check(true) — anyone with the
-- anon key could insert junk appointments. The app's booking path inserts via
-- the service-role client, so the policy is dead surface area: drop it.
drop policy if exists "appointments: public insert" on public.appointments;

-- Composite index the conflict check has always lacked.
create index if not exists idx_appointments_physician_slot
  on public.appointments (physician_id, scheduled_at)
  where physician_id is not null and scheduled_at is not null;

-- H6b: atomic slot-guarded booking insert. Advisory xact-lock per
-- (physician, slot) serializes racing bookings; honors allow_concurrent.
-- Pattern: commit_hmo_history_run (0036). service_role-only.
create or replace function public.appointments_insert_slot_guarded(
  p_rows jsonb,                -- array of appointment row objects
  p_physician_id uuid,         -- null ⇒ no slot guard, plain insert
  p_scheduled_at timestamptz,  -- null ⇒ no slot guard
  p_allow_concurrent boolean default false
)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing int;
  r jsonb;
  v_id uuid;
begin
  if p_physician_id is not null and p_scheduled_at is not null then
    perform pg_advisory_xact_lock(
      hashtext('appt_slot:' || p_physician_id::text || ':' || p_scheduled_at::text)
    );
    if not p_allow_concurrent then
      select count(*) into v_existing
        from public.appointments
       where physician_id = p_physician_id
         and scheduled_at = p_scheduled_at
         and status not in ('cancelled','no_show');
      if v_existing > 0 then
        raise exception 'slot_taken: that slot was just taken'
          using errcode = 'P0040';
      end if;
    end if;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.appointments (
      patient_id, service_id, physician_id, scheduled_at, notes, status,
      booking_group_id, home_service_requested, walk_in_name, walk_in_phone, created_by
    ) values (
      nullif(r->>'patient_id','')::uuid,
      nullif(r->>'service_id','')::uuid,
      nullif(r->>'physician_id','')::uuid,
      nullif(r->>'scheduled_at','')::timestamptz,
      nullif(r->>'notes',''),
      r->>'status',
      nullif(r->>'booking_group_id','')::uuid,
      coalesce((r->>'home_service_requested')::boolean, false),
      nullif(r->>'walk_in_name',''),
      nullif(r->>'walk_in_phone',''),
      nullif(r->>'created_by','')::uuid
    ) returning id into v_id;
    return next v_id;
  end loop;
end;
$$;
revoke all on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean) from public;
grant execute on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean) to service_role;

-- M4: TOCTOU-safe patient resolve (advisory lock around check-then-insert).
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex','')::text,
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true
  ) returning patients.id, patients.drm_id, false;
end;
$$;
revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;
```
(Adjust the two functions' column lists against `src/types/database.ts` at implementation time — e.g. `patients.sex` CHECK values; keep them in sync with `resolvePatient`'s current insert.)

- [ ] **Step 2: P0040 translation** — add to `src/lib/accounting/pg-errors.ts`: `case "P0040": return "That slot was just taken. Please pick another time.";` (byte-identical to the historical `slot_taken` message in `timing.ts`).
- [ ] **Step 3: local runbook** — `db reset`; anon-key insert into appointments now rejected (RLS); two concurrent RPC calls for the same slot: one wins, other raises P0040; `allow_concurrent=true` lets both through; multi-service doctor group (2 rows, same slot, one call) inserts fine; `resolve_patient_guarded` returns `reused=true` on the exact triple, inserts with `pre_registered=true` otherwise; two concurrent resolves of the same identity yield one row.
- [ ] **Step 4:** `npm run db:types` (RPC types regenerate) + `npm test`. Commit: `feat(db): booking slot guard RPC + drop open appointments INSERT policy + guarded patient resolve`

### Task 7.2: Wire app to the RPCs + slot_taken catch

**Files:**
- Modify: `src/lib/appointments/create.ts` (insert at lines 140–161; conflict model unchanged)
- Modify: `src/lib/patients/resolve.ts`

- [ ] **Step 1: `create.ts`** — replace the plain `admin.from("appointments").insert(rows)` with the RPC:

```ts
const { data: created, error } = await admin.rpc("appointments_insert_slot_guarded", {
  p_rows: rows,
  p_physician_id: physicianId ?? null,
  p_scheduled_at: timing.scheduledAtIso ?? null,
  p_allow_concurrent: allowConcurrent ?? false,
});
if (error) {
  if ((error as { code?: string }).code === "P0040") {
    return conflictResult([{ kind: "slot_taken", message: "That slot was just taken. Please pick another time." }]);
  }
  return { ok: false, error: translatePgError(error) };
}
```
where `conflictResult` = whatever shape the function already returns for strict-mode conflicts (reuse the existing conflict-return branch at lines 126–133 — in strict mode this surfaces the same public message as before; in relaxed mode it becomes an overridable warning EXCEPT `slot_taken`-at-insert must remain a hard error since the row wasn't inserted — return it as `ok:false` with the message in both modes). Keep the pre-insert SELECT check (fast-path UX conflict detection); the RPC is the authoritative last line. Apply the same RPC swap to `createLabRequestOnlyBooking` with null physician/slot (plain guarded insert). `allowConcurrent` is already fetched for `doctorCtx` — hoist it so the insert call can use it.
- [ ] **Step 2: `resolve.ts`** — replace `resolvePatient`'s two-step deps with a single RPC call:

```ts
export async function resolvePatient(admin: AdminClient, fields: ResolvePatientFields): Promise<ResolvePatientResult> {
  const email = fields.email.trim().toLowerCase();
  const { data, error } = await admin.rpc("resolve_patient_guarded", {
    p_email: email,
    p_last_name: fields.last_name,
    p_birthdate: fields.birthdate,
    p_fields: { ...fields, email },
  });
  const row = data?.[0];
  if (error || !row) return { ok: false, error: error?.message ?? "Could not save patient details." };
  return { ok: true, id: row.id, drm_id: row.drm_id, reused: row.reused };
}
```
Keep `resolvePatientCore` + its vitest suite untouched (pure logic contract unchanged; the wrapper now delegates the atomicity to the DB). Update `resolve.test.ts` only if it imports the wrapper.
- [ ] **Step 3:** `npm test && npm run typecheck && npm run build`; local smoke: public booking end-to-end, staff slide-over booking (relaxed + override), same-slot race via two rapid submissions ⇒ friendly slot-taken message. Commit: `fix(booking): atomic slot-guarded inserts + TOCTOU-safe patient resolve`

### Task 7.3: Reminder cron rolling catch-up (M1)

**Files:**
- Modify: `src/app/api/cron/appointment-reminders/route.ts` (lines 17–26)

- [ ] **Step 1:** widen the window — replace the `manilaDayWindowUtc(1)` gte/lt pair:

```ts
// M1: rolling catch-up — a missed cron run must not permanently drop that
// day's reminders. Window = [now, end of tomorrow Manila]: still-future
// appointments whose reminder was never stamped get caught up (possibly
// same-day), past appointments are never reminded retroactively.
const { endIso } = manilaDayWindowUtc(1);
const { data: due, error } = await admin
  .from("appointments")
  .select("id, patient_id")
  .eq("status", "confirmed")
  .gte("scheduled_at", new Date().toISOString())
  .lt("scheduled_at", endIso)
  .is("reminder_sent_at", null);
```
- [ ] **Step 2:** typecheck; local test: appointment tomorrow ⇒ selected; appointment later today with null stamp ⇒ selected (catch-up); stamped or past ⇒ not. Commit: `fix(reminders): rolling catch-up window so missed cron runs don't drop reminders`

### Task 7.4: /register fuzzy-dedup + pre_registered clearing + validation/ratelimit polish (M4, M5, M10)

**Files:**
- Modify: `src/app/(marketing)/register/actions.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx` + `patients/[id]/actions.ts`
- Modify: `src/lib/validations/patient.ts`, `src/lib/validations/patient-import.ts`
- Modify: `src/lib/rate-limit/check.ts`

- [ ] **Step 1: fuzzy dedup on /register (M4)** — in `submitRegistrationAction`, BEFORE `resolvePatient`: run `findCandidatesForInput` (from `src/lib/patients/find-duplicates.ts`) on the validated input; if the top candidate's tier is `exact_dup` or `strong`, treat it as the existing matched branch: email the DRM-ID to the CANDIDATE's on-file address (never echo on screen — enumeration safety), audit `patient.self_register.matched` with `metadata.dedup_tier`, return the same `{ ok: true, matched: true }` response. `probable`/`weak` ⇒ proceed to `resolvePatient` (which itself is now advisory-locked). No consent row on any matched path.
- [ ] **Step 2: pre_registered auto-clear (M5)** — in `createVisitAction`, after visits insert + PIN success (≈ line 351): `await admin.from("patients").update({ pre_registered: false }).eq("id", input.patientId).eq("pre_registered", true);` and, when a row was cleared, audit `"patient.identity_verified"` (`resource_type: "patient"`, metadata `{ via: "visit_created" }`).
- [ ] **Step 3: explicit verify action (M5)** — `verifyPatientIdentityAction(patientId)` in `patients/[id]/actions.ts`: `requireActiveStaff()` (reception does this at the counter), same update + audit (`{ via: "manual" }`); on the patient page, next to the "Pre-registered — verify identity" badge render a small `Mark identity verified` button (client wrapper calling the action).
- [ ] **Step 4: `.email()` (M10)** — in `patient.ts`, change `email: optionalText(160)` to
  `email: z.string().trim().email("Enter a valid email address.").max(160).or(z.literal("")).transform((v) => (v === "" ? null : v)).nullable()`; same for `patient-import.ts`'s email field. Run `npm test` (schema tests may need new cases: valid, blank ⇒ null, garbage ⇒ error).
- [ ] **Step 5: loud rate-limit fail-open (M10)** — in `check.ts`: both DB-error branches and the empty-identifier branch call `void reportError({ scope: "rate-limit", error: …, metadata: { bucket: cfg.bucket } })` before returning `allowed: true`. In `register/actions.ts` and `schedule/actions.ts`: when the IP is null (limit skipped), `void reportError({ scope: "rate-limit/no-client-ip", error: new Error("x-forwarded-for missing"), metadata: { bucket } })`; and swap their manual header-derivation to `ipAndAgent()`.
- [ ] **Step 6:** `npm test && npm run typecheck && npm run build`; smoke `/register` BOTH branches locally (new registrant ⇒ DRM-ID email + consent row; dedup/strong-fuzzy match ⇒ matched email, no new row) — the audit notes zero production usage, so this is the pre-poster smoke. Commit → PR (`fix: booking + registration hardening (PR 7)`).
- [ ] **PAUSE — user review (including the unique-index-vs-RPC deviation); then 0112 remote push (MCP + `'0112'`), pausing before the push.**

---

# PR 8 — Consent + notification correctness (H7, M2, M3, M6, M7, M10, LOWs)

**Branch:** `fix/consent-notifications` (off updated `origin/main`). **No migration.**

### Task 8.1: Intake consent banner + patients-without-consent report (H7)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/page.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/admin/reports/patients-without-consent/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/settings/consent-gate/page.tsx`, `src/components/staff/staff-nav-config.ts`

- [ ] **Step 1: intake banner** — in `visits/new/page.tsx`, when a patient is selected (the `VisitForm` branch, ≈lines 63–79): `const consent = await getPatientConsentState(patient.id);` and when `!consent.current` render an amber banner above the form: `Data-privacy consent is not on file for {name}. Capture it now — once the consent gate is enabled, results cannot be released without it.` + `<Link href={/staff/patients/${patient.id}#consent}>Record consent →</Link>` (add `id="consent"` anchor on the patient page's ConsentPanel wrapper). Banner only — visit creation is NOT blocked (gate ships OFF).
- [ ] **Step 2: report page** — `/staff/admin/reports/patients-without-consent` (staff-advances template): `requireAdminStaff()`; admin-client query `patients` where `consent_current = false` and `merged_into_id is null`, joined visit stats (`visits` count + max date via a second `.in()` query), ordered by last-visit desc, `.limit(500)` + cap notice; columns: Patient (link), DRM-ID, Pre-registered badge, Visits, Last visit, Phone/email presence; header states the RA-10173 purpose: run this to zero BEFORE enabling the consent gate.
- [ ] **Step 3: cross-links + nav** — consent-gate settings page: add a line above the toggle linking the report (`{blockedCount} active patients lack consent — review the list before enabling`). Nav (Books & reports): `{ href: "/staff/admin/reports/patients-without-consent", label: "Patients without consent", description: "Active patients with no data-privacy consent on file — clear this list before enabling the consent gate, or their releases will block.", roles: ["admin"] }`.
- [ ] **Step 4:** typecheck/build + smoke. Commit: `feat(consent): intake banner + patients-without-consent pre-flight report`

### Task 8.2: Portal consent gate suppresses the data fetch (M3)

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/layout.tsx`
- Modify: `src/app/(patient)/portal/(authenticated)/consent/consent-gate.tsx` (presentation only, if needed)

- [ ] **Step 1:** stop rendering children (and thus their RSC data fetch) pre-consent:

```tsx
return (
  <PatientShell patient={patient}>
    {consent.current ? children : <PortalConsentGate />}
  </PatientShell>
);
```
`PortalConsentGate` becomes a normal full-page section rather than a `fixed inset-0 z-50` overlay (drop the overlay positioning classes; keep the ConsentNotice + accept flow; `acceptConsentPortalAction` already `revalidatePath("/portal", "layout")` so accepting re-renders with children). Verify no page depends on rendering while unconsented (help page lives outside `(authenticated)`? if `help/page.tsx` is inside the group and should stay reachable, allowlist it by moving it out of the group or accepting the gate on it — check at implementation and prefer gating everything).
- [ ] **Step 2:** verify: fresh patient with `consent_current=false` logs in ⇒ page HTML/flight payload contains NO result rows (curl the page, grep for a seeded test name), accept ⇒ results appear. Commit: `fix(portal): consent gate suppresses result data fetch instead of overlaying it`

### Task 8.3: NOTIFICATIONS_LIVE guard (M6) + physical/pickup skip (M7)

**Files:**
- Modify: `src/lib/notifications/email.ts`, `sms.ts`, `.env.example`
- Modify: `src/lib/notifications/notify-released.ts`, `notify-released-bulk.ts`, `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`

- [ ] **Step 1: env guard (M6)** — top of `sendEmail` and `sendSms`, before the key checks (mirror the IndexNow guard precedent):

```ts
// M6: real keys in .env.local + `npm run dev` must never message real
// patients. Sends require production, or an explicit local opt-in.
const live = process.env.VERCEL_ENV === "production" || process.env.NOTIFICATIONS_LIVE === "true";
if (!live) {
  return { ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" };
}
```
`.env.example`: add `# Outbound email/SMS only fire on Vercel production. Set to "true" locally to test real sends.` `NOTIFICATIONS_LIVE=`. (Skipped results flow into the existing audit metadata unchanged — admin page shows them as skipped.)
- [ ] **Step 2: physical/pickup skip (M7 — user-confirmed decision)** — `notifyResultReleased` gains `releaseMedium` in its input; `releaseTestAction` passes it. At the top of the notifier (after fetching patient), when `releaseMedium === "physical" || releaseMedium === "pickup"`: write the `result.notified` audit row with both channels `{ ok: false, skipped: true, reason: "physical hand-off — no message sent" }` and return without sending. Same parameter + branch in `notifyResultsReleasedBulk` (bulk action passes its medium).
- [ ] **Step 3:** unit-testable? The guard lives in sendEmail/sendSms (server-only) — cover via local smoke instead: dev-mode release ⇒ emails-sent page shows skipped w/ the env reason; `NOTIFICATIONS_LIVE=true` + Inbucket (local supabase mail catcher won't apply to Resend — skip real-send verification, assert the code path via logs). Commit: `feat(notifications): environment send-guard + skip messaging on physical/pickup hand-offs`

### Task 8.4: Merge notification (M2) + visit_pin.issued (M10) + LOW fixes

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`
- Modify: `src/lib/notifications/notify-released.ts`, `notify-appointment-booked.ts`, `README.md` (comment drift)
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts`

- [ ] **Step 1: merge notification (M2)** — in `mergePatientsAction`, after the tombstone + ledger writes succeed: if the kept row has an email, `sendEmail` using the register-matched template shape (`renderEmailShell` + `emailHighlight("Your DRM-ID", kept.drm_id)`, copy: records were combined; use THIS DRM-ID with the PIN from your most recent receipt); fold the send outcome into the existing `patient.merged` audit metadata as `notification: { email: <ok/skipped/error shape> }`. Never include the retired DRM-ID's PIN details.
- [ ] **Step 2: visit_pin.issued (M10)** — in `createVisitAction`, inside the per-visit audit loop (≈lines 357–404) after the `visit.created` row: add an audit row `action: "visit_pin.issued"`, `resource_type: "visit"`, `resource_id: c.visitId`, `patient_id`, metadata `{ visit_number: c.visitNumber, reason: "visit_created" }` — model on `visit_pin.reissued` (`patients/[id]/actions.ts:59–73`). NEVER put the PIN (or hash) in metadata.
- [ ] **Step 3: SMS comment drift (LOW)** — update `notify-released.ts` lines 18–20 and `notify-appointment-booked.ts` lines 16–17 to the `notify-appointment-reminder.ts` honesty pattern (SMS is skipped unless Semaphore is configured — it never has been in prod); fix README lines 20/155 the same way.
- [ ] **Step 4: `updatePatientAction` RLS-bound client (LOW)** — FIRST check the `patients` UPDATE policy in 0001 (`grep -n '"patients:' supabase/migrations/0001_init.sql`): if staff UPDATE is role-based (has_role) with no ownership clause, swap `createAdminClient()` → `await createClient()` for the patients update (keep the consent-grant call unchanged — it's a separate action); if the policy is ownership-scoped, add the role-based UPDATE policy in the next migration instead and note it — do NOT ship a swap that breaks reception edits. Verify locally as reception: edit a patient another user created.
- [ ] **Step 5:** `npm test && npm run typecheck && npm run build`; smoke: merge two seeded patients ⇒ kept-DRM-ID email row in emails-sent; new visit ⇒ `visit_pin.issued` audit row. Commit → PR (`fix: consent + notification correctness (PR 8)`). **PAUSE — user review.**

---

# PR 9 — Portal RLS enforcement (H2)

**Branch:** `feat/portal-rls` (off updated `origin/main`)
**Migration:** `0113_portal_rls_enforcement.sql` ⚠ high effort

> **Design (and its stop-condition).** `set_patient_context()` sets a
> transaction-local GUC, but PostgREST wraps every supabase-js call in its own
> transaction — two JS calls can never share it. The workable PostgREST-native
> bridge: the server mints a short-lived **Supabase-verifiable JWT** (role
> `anon`, custom claim `patient_id`) per request and builds a patient-scoped
> client with it; `current_patient_id()` is extended to read the claim. RLS then
> genuinely evaluates on every portal query. **Feasibility gate (Task 9.1):**
> this requires the project's legacy symmetric JWT secret (HS256). If the
> project runs only asymmetric signing keys and no shared secret is available,
> STOP and report per the programme instruction — do not fall back silently.

### Task 9.1 ⚠: Feasibility spike (STOP-gate)

- [ ] **Step 1:** local stack: mint a JWT with `jsonwebtoken` signed with the local `SUPABASE_JWT_SECRET` (from `supabase status`), payload `{ role: "anon", patient_id: "<uuid>", exp: now+300 }`; `createClient(url, ANON_KEY, { global: { headers: { Authorization: "Bearer <jwt>" } } })`; query `visits`. Verify PostgREST accepts it and `current_setting('request.jwt.claims', true)` carries `patient_id` (probe via a throwaway `select current_setting…` RPC).
- [ ] **Step 2:** prod feasibility check (read-only): confirm a legacy JWT secret exists for `qhptbmafrosgibooelpp` (dashboard → Settings → API → JWT secret; or Management API). **If none / asymmetric-only: STOP, report to the user with the findings and the alternative (codified admin-filter pattern + lint/test), and await direction.**
- [ ] **Step 3:** report spike result at the PR-9 kickoff before writing the migration.

### Task 9.2 ⚠: Migration 0113 — claim-aware `current_patient_id()` + missing patient policies

**Files:**
- Create: `supabase/migrations/0113_portal_rls_enforcement.sql`

- [ ] **Step 1:**

```sql
-- H2: make the patient RLS policies actually enforce. current_patient_id()
-- now reads (in order) the transaction GUC (legacy bridge, still supported)
-- then the signed JWT claim minted by the portal server per request.
create or replace function public.current_patient_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('app.current_patient_id', true), '')::uuid,
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'patient_id', '')::uuid
  );
$$;

-- 0051 recreated the results patient policy as `to authenticated` only,
-- dropping anon — an anon-key patient client would see zero results. Fix.
drop policy if exists "results: patient released only" on public.results;   -- ← verify exact live name first
create policy "results: patient released only"
  on public.results for select to anon, authenticated
  using (exists (
    select 1 from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    where rtr.result_id = results.id
      and tr.status = 'released'
      and v.patient_id = public.current_patient_id()
  ));

-- Junction + attachments had NO patient policy at all (portal always used the
-- admin client). Scope both to released tests / own rows.
create policy "result_test_requests: patient released only"
  on public.result_test_requests for select to anon, authenticated
  using (exists (
    select 1 from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
    where tr.id = result_test_requests.test_request_id
      and tr.status = 'released'
      and v.patient_id = public.current_patient_id()
  ));

create policy "appointment_attachments: patient self"
  on public.appointment_attachments for select to anon, authenticated
  using (patient_id = public.current_patient_id());

-- test_requests / visits / patients / payments patient policies (0001) already
-- read current_patient_id() with `to anon, authenticated` — no change needed.
```
(Before writing: `select polname, tablename from pg_policies` on the local stack to confirm exact policy names; also confirm every column the portal queries — e.g. `services` join — has anon-readable policies; `services` is public-read already via the marketing site, verify.)

- [ ] **Step 2: local runbook** — with a minted patient JWT: patient A sees own released results, zero rows of patient B's; unreleased/undone (PR 3) results invisible; junction + attachments scoped; with NO claim ⇒ zero rows everywhere. Legacy GUC path (`set_patient_context` inside one RPC) still works.
- [ ] **Step 3:** `npm run db:types` + `npm test`. Commit: `feat(db): claim-aware current_patient_id + complete patient SELECT policies`

### Task 9.3: Patient-scoped client + portal read migration

**Files:**
- Create: `src/lib/supabase/patient.ts`
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`, `visits/[id]/page.tsx`, `data-export/route.ts`, `actions.ts`
- Create: `src/lib/portal/portal-scoping.test.ts` (static guard test)

- [ ] **Step 1: `createPatientClient(patientId)`** (`src/lib/supabase/patient.ts`, `import "server-only"`):

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose"; // already a transitive dep of patient-session; confirm import path used there and reuse it
import type { Database } from "@/types/database";

// Patient-scoped client: anon role + a signed patient_id claim, so the
// patient RLS policies genuinely evaluate on every query (H2). The app-level
// .eq("patient_id", …) filters stay as defense-in-depth.
export async function createPatientClient(patientId: string) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not configured");
  const token = await new SignJWT({ role: "anon", patient_id: patientId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
```
(Reuse the exact JWT lib `patient-session.ts` already uses — check whether it's `jose` or `jsonwebtoken` and match. Add `SUPABASE_JWT_SECRET` to `.env.example` with a comment.)
- [ ] **Step 2: migrate the read paths** — in `page.tsx` (`loadResults`, pending-count, uploads), `visits/[id]/page.tsx`, `data-export/route.ts`: replace `createAdminClient()` with `await createPatientClient(patient.patient_id)` for the READS. **Keep the admin client where it is genuinely required:** storage signed URLs / `.download()` (buckets have no patient policy — signed-URL minting stays admin + audited), `audit()` writes (admin by design), `login/actions.ts` (pre-auth), consent state reads in the layout (fine either way — move to patient client if policies allow reading own `patients` row: policy #1 covers it). Keep every existing `.eq("patient_id", …)` filter (defense-in-depth). In `actions.ts`, the ownership VERIFICATION queries before signed-URL minting move to the patient client (RLS now backs them); the storage + audit steps stay admin.
- [ ] **Step 3: the guard test** — `portal-scoping.test.ts` (vitest, pure fs — no DB): read every `.ts/.tsx` file under `src/app/(patient)/portal/`, assert `createAdminClient` appears ONLY in the allowlisted files (`actions.ts` for storage/audit, `login/actions.ts`, layout consent read if kept) and that files matching `page.tsx|route.ts` under `(authenticated)/` import `createPatientClient`. Failing this test = a new portal page skipped RLS.
- [ ] **Step 4: verify end-to-end (local)** — patient login → results list, visit detail, package download, data export all work; cross-patient probe: hand-edit a visit id in the URL from patient B ⇒ empty/404 (now RLS-backed, not just app-filter); undo a release (PR 3) ⇒ result vanishes from a LIVE portal session on refresh. `npm test && npm run typecheck && npm run build`.
- [ ] **Step 5 (optional rider, confirm with user):** harmonize the patient visit-detail package display with the main list's `PackageCard` (suppress header "No file" rows; group components under the package with the consolidated download button — reuse `PackageGroup` builder from `page.tsx` by extracting it to `src/lib/portal/package-groups.ts`).
- [ ] **Step 6:** Commit → PR (`feat: portal reads through real patient RLS (PR 9)`). **PAUSE — user review; then 0113 remote push (MCP + `'0113'`), pausing before the push. Post-deploy: verify prod portal login + downloads immediately; instant rollback path = revert the app deploy (policies are additive and the GUC path remains).**

---

## Testing summary (programme-wide)

- **vitest:** queue-stage released-names (incl. cancelled-exclusion) · patient schema email cases · portal-scoping static guard · any pure helpers added along the way. `npm test` green before every commit.
- **Migration runbooks (local stack):** each ⚠ task carries its own numbered scenario; run against `supabase db reset` and record outcomes in the PR description.
- **Manual smokes per PR:** listed in each PR's final task. #0037-shaped seed data is the canonical fixture for PRs 2–4.
- **Invariants that must hold at every PR boundary:** payment + consent gates DB-enforced on every (re-)release · `released` ⇔ posted JE, undone ⇔ reversed + reversal, re-released ⇔ fresh posted JE · every state change audit-logged with actor (+ reason where human-initiated) · portal visibility only ever shows `status='released'`.

## Effort / model guidance

- ⚠ tasks (0109, 0110, 0111, 0112, 0113 + their runbooks): **high effort**, main-session or strongest subagent.
- Everything else: Sonnet subagents are fine.

## Deferred (explicitly NOT in this programme)

Real pathologist sign-off queue (PR 6 defuses the hazard) · "add test to existing visit" · stigma-sensitive service-name wording in notifications · visit↔appointment linkage / no-show sweep.

