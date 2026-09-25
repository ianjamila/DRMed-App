# Staff "View as role" for admins — design

**Date:** 2026-09-25
**Status:** approved design, awaiting implementation plan
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
   purpose.

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
and grants unchanged) to read the effective role:

```sql
case
  when role = 'admin' and view_as_until > now() then view_as_role
  else role
end
```

`is_staff()` is unchanged (existence, not role). `now()` inside a `stable`
function is fine. The `(select public.has_role(...))` initplan wrapping style
that `rls-initplan.test.ts` checks is a call-site property and is untouched.

`0172_result_edit_commit.sql` reads `public.staff_role()` for its role check
and therefore follows the simulation automatically. `0167`'s real-role check
stays real-role: a simulating admin cannot reach the patient-delete UI anyway.

Regenerate `src/types/database.ts` for the two columns.

## 2. Session

`requireSignedInStaff()` selects the two new columns and computes the
effective role with one pure helper, `effectiveRole(profile, now)` in a new
`src/lib/auth/view-as.ts`, so the TS rule and the SQL rule are pinned to each
other by a test. `StaffSession` gains:

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
  Set `view_as_until = now + 4h`. Audit, then `redirect("/staff")` (the
  current page may be admin-only and would bounce anyway).
- `exitViewAsAction()` — same guard on `actual_role`; null both columns;
  audit; `redirect("/staff")`.

Expiry needs no code path: the next request computes the real role and the
banner disappears. Stale columns are overwritten on the next start or exit.

## 4. UI

- **Sidebar footer** (`staff-shell.tsx`): for `actual_role === "admin"`, a
  compact native `<select>` labelled "View as" listing Reception, Medical
  Tech, X-ray Technician, Pathologist, submitting `startViewAsAction` on
  change (same pattern as other footer forms). Non-admins see nothing new.
- **Banner** (`src/components/staff/view-as-banner.tsx`): rendered by the
  shell above the page content, desktop and mobile, `print:hidden`, amber
  (`role="status"`). Text: "Viewing as Reception. Anything you save is
  recorded under your name. Ends in 3h 40m." Contains an **Exit** button
  (`exitViewAsAction`) and the same role select for hopping between roles
  without exiting. The countdown is computed server-side from `view_as.until`
  at render (no client timer).
- **Footer role line** while simulating: "Reception (viewing as) · Admin".
- `ROLE_LABEL` moves from `staff-shell.tsx` to `src/lib/staff/role-labels.ts`
  and is imported by the shell, the banner and the select; existing
  duplicates elsewhere are left alone (not in scope).

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
  that admin shows the banner. Intended.
- Prod data is real; the banner says so on every page.
- No non-admin can ever set the override: the action guards on
  `actual_role`, and the helpers ignore an override on a non-admin row.

## 7. Testing

- `view-as.test.ts`: `effectiveRole()` — admin+future → override; admin+past
  → admin; non-admin+future → real role; nulls → real role.
- Migration test (text-pinned like `result-edit-migration.test.ts`): the new
  migration redefines exactly `staff_role` and `has_role`, keeps
  `security definer` + `set search_path`, and contains the effective-role
  `case`; grants unchanged (`seed-grant-parity.test.ts` must stay green).
- Action tests: non-admin `actual_role` refused; invalid role refused;
  admin start writes columns + audit `started`; exit nulls + `ended`.
- `view-as-banner.test.tsx`: renders role label, countdown, Exit; absent
  when `view_as` is null.
- `staff-shell.test.tsx` (extend or add): select present only for admins.
- Manual pass on the local dev server: view as each of the four roles;
  sidebar equals that role's nav; an admin-only page redirects to `/staff`;
  a lab-queue claim honours the role; Exit restores admin.

## 8. Rollout

Migration first (additive, old code ignores the columns), code deploy
second. The reverse order would break every staff page, because the session
loader selects columns that would not exist yet. Follow
`feedback-drmed-apply-migrations-yourself`: dry-run, push from this branch
right before merge, verify by object (`\d staff_profiles` shows both columns;
`select has_role(array['admin'])` semantics checked via a fixture on local).
