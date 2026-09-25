# Staff "View as role" for admins — design

**Date:** 2026-09-25
**Status:** approved design, Codex Astra (high) plan review applied, awaiting implementation plan
**Branch:** `feat/staff-view-as-role`

## Problem

An admin testing `/staff` cannot see what Reception, a Medical Tech, an X-ray
Technician or a Pathologist actually sees without signing out and signing in
as a second account. DRMed enforces roles in two places that must agree:

1. **App layer.** Every staff page reads `session.role` from
   `requireActiveStaff()` (`src/lib/auth/require-staff.ts`). About 170 call
   sites branch on it: sidebar (`staff-nav-config.ts`), dashboards, buttons,
   `requireAdminStaff()`, claim rules (`role-sections.ts`), quick quote,
   notification bell.
2. **Database layer.** Row-level security reads the role through three
   helper functions from `0001_init.sql` — `is_staff()`, `staff_role()` and
   `has_role(text[])` — all of which look up `staff_profiles` by `auth.uid()`.
   49 migrations use them; 154 policies are `has_role(array['admin'])`.
   No policy or function reads `staff_profiles.role` directly, except
   `0167_patient_soft_delete.sql`, which checks a passed actor's real role on
   purpose (service-role-only RPCs whose app actions call `requireAdminStaff()`).
   No migration after 0001 redefines `staff_role()` or `has_role()` (verified
   by Codex review 2026-09-25).

An app-only switch (cookie) would make the screens match but leave the
database treating the user as admin, so lists and reports could include rows a
real front-desk user never sees. Rejected. Seeded per-role test accounts were
rejected because they are exactly the second login the owner wants to avoid.

## Decisions (owner, 2026-09-25)

- Full actions allowed while viewing as another role. Writes land under the
  admin's real identity in `audit_log`, bracketed by start/end events.
- Approach: **profile-row override** — the override lives on the admin's own
  `staff_profiles` row and both layers derive the effective role from it.
- All four non-admin roles are offered.
- The override auto-expires after 4 hours.

## 1. Data and database rules

One additive migration (number claimed at planning time — `0179` and `0181`
are held by open branches, `0180` is on prod; follow
`drmed-migration-number-collision`):

```sql
alter table public.staff_profiles
  add column view_as_role  text        null,
  add column view_as_until timestamptz null;

alter table public.staff_profiles
  add constraint staff_profiles_view_as_role_check
    check (view_as_role is null
           or view_as_role in ('reception','medtech','pathologist','xray_technician')),
  add constraint staff_profiles_view_as_pair_check
    check ((view_as_role is null) = (view_as_until is null));
```

Deliberately **no** constraint tying `view_as_role` to `role = 'admin'`: if
another admin demotes a currently-simulating admin, that update must not
fail. The effective-role rule below already ignores an override on any
non-admin row, so a stale override is inert.

The same migration redefines `staff_role()` and `has_role(text[])` (bodies
only; signatures, `stable`, `security definer`, `set search_path = public`
unchanged) to read the effective role:

```sql
case
  when role = 'admin' and view_as_until > now() then view_as_role
  else role
end
```

`create or replace` preserves the functions' ACLs, but the migration must
still **assert** them the way `0118_security_definer_revoke_anon.sql` does:
`has_function_privilege('anon', …, 'EXECUTE')` and the same for
`authenticated` on all three helpers, raising if any is lost — a helper that
anon cannot execute makes every policy that calls it raise instead of filter.

`is_staff()` is unchanged (existence, not role). `now()` inside a `stable`
function is fine. The comparison is strict (`>`): an override whose expiry
equals the current instant is inactive. The `(select public.has_role(...))`
initplan wrapping style that `rls-initplan.test.ts` checks is a call-site
property and is untouched.

`0172_result_edit_commit.sql` reads `public.staff_role()` for its role check
and therefore follows the simulation automatically. `0167`'s real-role check
stays real-role: a simulating admin cannot reach the patient-delete UI anyway.

Regenerate `src/types/database.ts` for the two columns.

## 2. Session

`requireSignedInStaff()` selects the two new columns and computes the
effective role with one pure helper, `effectiveRole(profile, now)` in a new
`src/lib/auth/view-as.ts`, so the TS rule and the SQL rule are pinned to each
other by a test. The self-read policy (`0151`, `id = auth.uid()`) does not
depend on role, so the loader still gets the row under any effective role.
`StaffSession` gains:

```ts
actual_role: StaffSession["role"];              // the real profile role
view_as: { role: StaffSession["role"]; until: string } | null;  // active override only
```

`role` keeps meaning "the role every page should behave as", so all existing
call sites, `requireAdminStaff()`, `sectionsForRole()`, `canClaimSection()`,
`canUseQuickQuote()`, badges and the bell follow the simulation with no
edits. The three test files that build a `StaffSession` literal gain the two
fields. The MFA gate keys on enrolled factors, not role, and is untouched.

## 3. Switching

New server actions in `src/app/(staff)/staff/(dashboard)/view-as/actions.ts`:

- `startViewAsAction(formData)` — `requireActiveStaff()`, then refuse unless
  `session.actual_role === "admin"` (never `session.role`, which is the
  simulated one). Validate the role with a zod enum of the four roles.
  Update the caller's own row (`id = session.user_id`) through
  `createAdminClient()` — the service-role client is required because while
  simulating, `has_role(array['admin'])` is false and the "admin manage"
  policy would block the admin from editing their own row to switch or exit.
  Set `view_as_until = now + 4h`. Audit, then
  `revalidatePath("/staff", "layout")` (the shell — sidebar, footer, banner —
  is rendered by the shared dashboard layout, which Next caches across client
  navigations; `messages/actions.ts` invalidates it the same way for the
  badge), then `redirect("/staff")` (the current page may be admin-only and
  would bounce anyway).
- `exitViewAsAction()` — same guard on `actual_role`; null both columns;
  audit; same revalidate; `redirect("/staff")`.

**Keeping the shell in step with authorization.** The database applies the
override on every request; the shell must never show a role the database has
stopped applying. Three cases:

- *Start / switch / exit in this tab:* covered by the layout revalidation
  above.
- *Expiry in this tab:* the banner is a client component that schedules one
  `router.refresh()` at `view_as.until` (from the server-provided timestamp,
  not a client clock offset). The refreshed layout sees no active override
  and drops the banner.
- *Change from another tab or device:* the banner (and, for admins with no
  active override, a tiny headless client hook in the shell) calls
  `router.refresh()` on `visibilitychange` → visible. So a tab that was in
  the background catches up when the admin returns to it. A tab that stays in
  the foreground while another device switches keeps the stale shell until
  its next navigation; every server action and page render still uses the
  database's effective role, so the stale shell can only mislead, never
  authorize. The banner text states the role the database is using at
  render time, and the countdown is rendered server-side.

## 4. UI

- **Sidebar footer** (`staff-shell.tsx`, desktop): for
  `actual_role === "admin"`, a compact native `<select>` labelled "View as"
  listing Reception, Medical Tech, X-ray Technician, Pathologist, submitting
  `startViewAsAction` on change (same form pattern as the Sign out button
  beside it). Non-admins see nothing new.
- **Mobile drawer footer** (`staff-mobile-nav-trigger.tsx`, below `md`): the
  identical select in the drawer footer next to Sign out. The trigger
  currently receives `role`, `email`, `fullName`, `badges`; it gains
  `actualRole` and `viewAs` so an admin can start from a phone.
- **Banner** (`src/components/staff/view-as-banner.tsx`): rendered by the
  shell above the page content on every width, `print:hidden`, amber,
  `role="status"`. Text: "Viewing as Reception. Anything you save is recorded
  under your name. Ends in 3h 40m." Contains an **Exit** button
  (`exitViewAsAction`) and the same role select for hopping between roles
  without exiting first.
- **Footer role line** while simulating (desktop and mobile): "Reception
  (viewing as) · Admin".
- `ROLE_LABEL` is duplicated today in `staff-shell.tsx` and
  `staff-mobile-nav-trigger.tsx`; both move to one export in
  `src/lib/staff/role-labels.ts`, imported by the shell, the trigger, the
  banner and the select. Other duplicates elsewhere are left alone.

## 5. Audit

Two new actions, actor = the admin's real id, `actor_type: "staff"`, with
`ipAndAgent()`:

- `staff.view_as.started` — `metadata: { role, until }`
- `staff.view_as.ended` — `metadata: { role, reason: "manual" | "switched" }`

Switching from one role to another writes `ended(switched)` then `started`.
Writes made while simulating are **not** individually tagged (that would
touch every `audit()` call site); the start/end events bracket them.
Expiry writes no event; `started` already carries `until`.

## 6. Edge cases

- The Users admin page and any staff list show the admin's **real** role;
  the override is session state, not a job change.
- A demoted or deactivated admin: override inert (rule requires
  `role = 'admin'`); deactivated accounts are refused by the session gate.
- Multiple tabs/devices: the override is on the row, so every session of
  that admin is governed by it immediately and shows the banner on its next
  render (see §3 for how tabs catch up).
- Prod data is real; the banner says so on every page.
- No non-admin can ever set the override: the action guards on
  `actual_role`, and the helpers ignore an override on a non-admin row.

## 7. Testing

**Unit (vitest):**
- `view-as.test.ts`: `effectiveRole()` — admin+future → override; admin+past
  → admin; admin+exactly-now → admin (strict `>`); non-admin+future → real
  role; nulls → real role; an ISO `+08:00` `until` and its UTC equivalent
  resolve identically.
- Migration test (text-pinned like `result-edit-migration.test.ts`): the new
  migration redefines exactly `staff_role` and `has_role`, keeps
  `security definer` + `set search_path`, contains the effective-role `case`
  and the `has_function_privilege` assertions.
- Action tests: non-admin `actual_role` refused; invalid role refused;
  admin start writes columns + audit `started` + revalidates layout; exit
  nulls + `ended`; switch writes `ended(switched)` then `started`.
- `view-as-banner.test.tsx`: renders role label, countdown, Exit, select;
  absent when `view_as` is null.
- Shell and mobile-trigger tests: select present only when
  `actualRole === "admin"`; footer line shows "(viewing as)" when active.

**Database (local stack, replayed fresh):** `supabase db reset` then a
`supabase/tests/NNNN_view_as_smoke.sql` in the existing BEGIN/ROLLBACK
style with an explicit control. Under `set role authenticated` and a
`request.jwt.claims` sub for a fixture admin:
- helper ACLs: anon and authenticated can execute all three helpers;
- override active → `has_role(array['admin'])` false, `staff_role()` =
  'reception', self-read of own `staff_profiles` row succeeds, a direct
  update of own row (the exit path without service role) is denied — this
  is why the action uses the service-role client;
- for each of the four roles: one representative permitted read and one
  denied read/write match a genuine fixture user of that role (RLS
  equivalence, not just "something was filtered"); include the lab-queue
  claim path for `xray_technician` vs `medtech`;
- non-admin fixture with override columns set → real role still applies;
- expired and exactly-now `view_as_until` → admin; demoted admin → inert;
- control: with the override rows cleared, the same probes return the admin
  results (a probe that cannot distinguish the two proves nothing).

**Browser (local dev server, admin signed in):** start, switch, and exit at
desktop width and at mobile width, no manual reload: sidebar/drawer matches
the role, an admin-only page redirects to `/staff`, Exit restores admin. Two
tabs open: switch in tab A, focus tab B → banner updates. Expiry: set a short
`until` via SQL, wait, banner disappears without reload.

## 8. Rollout and rollback

**Rollout.** Migration first, code deploy second. The schema is additive and
the old session loader ignores the columns, and nothing can *set* an override
until the new code is live, so the mixed window is safe by construction. The
reverse order would break every staff page (the loader selects columns that
do not exist yet). Follow `feedback-drmed-apply-migrations-yourself`:
dry-run, push from this branch right before merge, verify by object (both
columns and both constraints on `staff_profiles`; `\df+ has_role` shows the
new body and anon EXECUTE).

**Rollback of the app while the migration stays.** Old code reports the real
role while the migrated helpers keep applying any *active* override, and old
code has no Exit control. Procedure, in order: (1) clear every override with
`update staff_profiles set view_as_role = null, view_as_until = null where
view_as_role is not null`; (2) verify `select count(*) … where view_as_role
is not null` is 0; (3) redeploy the old app. No override can be started
again until the new code returns. The migration itself never needs
reverting; with the columns null the helpers behave exactly as before.
