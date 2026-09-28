# Admin "View as role" — follow-ups (design)

Date: 2026-09-28 · Parent: `2026-09-25-staff-view-as-role-design.md` (#237, migration 0182)
Status: owner-approved scope (12 items) and design (2026-09-28).
Migration: **0187** (`0187_view_as_followups.sql`). Error code: **P0074**.

Sources: post-merge Codex review (xhigh) of #237 — four P2s and one P3, each
verified against the code — plus seven refinements the owner approved.

## Goals

| # | Item | Kind |
|---|------|------|
| 1 | Picker shows the old role after a switch; re-picking fires nothing | Codex P2 |
| 2 | Expiry timer runs on the device clock; banner can linger | Codex P2 |
| 3 | Start/exit are not atomic; two tabs double-log or lose an `ended` row | Codex P2 |
| 4 | Mobile drawer stays open after a View-as switch | Codex P2 |
| 5 | A foreground tab keeps a stale shell across client navigations | Codex P3 |
| 6 | Banner: absolute Manila end time + live countdown | refinement |
| 7 | Switch/exit returns to the page you were on when the new role can use it | refinement |
| 8 | Failed switch shows an error with a pending state | refinement |
| 9 | DB smoke: Pathologist equivalence + a real X-ray Claim write | refinement |
| 10 | Ordinary audit rows written during a simulation carry the simulated role | refinement |
| 11 | "Active role views" readout on Staff Users (admin only) | refinement |
| 12 | Lazy `staff.view_as.ended` / `reason: "expired"` on first request after expiry | refinement |

Non-goals: an admin ending *another* admin's view ("End now"); an `acting_as`
filter in the audit viewer. Both are listed as follow-up ideas.

## 1. Database — migration 0187

All three objects are `security definer`, `set search_path = public`, and
closed to `public, anon, authenticated` (service_role only), matching the
`result_copy_states_internal` pattern in 0179. The migration ends with an ACL
assertion block like 0182's.

### 1a. `view_as_transition(p_actor uuid, p_role text, p_ip inet, p_ua text) returns jsonb` (item 3)

One transaction does the whole state change:

1. `select … from staff_profiles where id = p_actor and role = 'admin' and
   is_active and deleted_at is null for update`. No row → `raise exception
   'Only an admin can view the app as another role.' using errcode = 'P0074'`.
2. `p_role` not null and not one of the four View-as roles → `raise exception
   'Unknown role.' using errcode = '22023'` (the check constraint would also refuse).
3. Close the prior state, if the row carries one (`view_as_role is not null`):
   - still active (`view_as_until > now()`) → insert `staff.view_as.ended`
     `{role, reason: p_role is null ? 'manual' : 'switched'}`;
   - already past → insert `staff.view_as.ended` `{role, reason: 'expired',
     expired_at: <old until>}`.
4. Write the new state: `p_role` → `view_as_role = p_role, view_as_until =
   now() + interval '4 hours'` and insert `staff.view_as.started` `{role, until}`;
   null → clear both columns.
5. Return `{"role": <new role or null>, "until": <new until or null>}`.

All audit rows: `actor_id = p_actor`, `actor_type = 'staff'`, `ip_address =
p_ip`, `user_agent = p_ua`. Because the row lock serialises concurrent callers,
the second of two racing exits sees a cleared row and writes nothing; the
second of two racing starts closes the first as `switched`. Exiting with no
override writes nothing (as today). Re-picking the role already in force
restarts the 4 hours (`ended:switched` + `started`), as today.

The 4-hour length lives in SQL now; `VIEW_AS_DURATION_MS` stays in TS for the
UI and a migration-pin test asserts the two agree.

### 1b. `view_as_expire(p_actor uuid, p_ip inet, p_ua text) returns boolean` (item 12)

A single conditional `update staff_profiles set view_as_role = null,
view_as_until = null where id = p_actor and role = 'admin' and view_as_role is
not null and view_as_until <= now() returning <old role, old until>` (old
values via a `for update` CTE). Inserts `staff.view_as.ended` `{role, reason:
'expired', expired_at}` only when a row was updated; returns whether it did.
Concurrent callers: the second waits on the row lock, re-evaluates the WHERE,
matches nothing, writes nothing.

### 1c. Audit stamp trigger (item 10)

`before insert on audit_log for each row execute function
audit_log_stamp_view_as()`. When `new.actor_type = 'staff'`, `new.actor_id` is
not null and `new.action not like 'staff.view_as.%'`, it looks up the actor's
effective override (`role = 'admin' and view_as_until > now()`, same CASE as
0182). If there is one and `new.metadata` is null or a JSON object, it sets
`new.metadata = coalesce(new.metadata, '{}') || jsonb_build_object('acting_as',
view_as_role)`. A non-object metadata value is left untouched (none exist
today; merging would turn it into an array).

Why a trigger and not `src/lib/audit/log.ts`: several SQL functions insert
audit rows directly with `auth.uid()` (e.g. `result_mark_copy_contacted` in
0179, 0167, 0173); a TS-only stamp would miss them. Cost: one primary-key
lookup per staff audit insert.

## 2. Server

### 2a. Switch core — `src/lib/auth/view-as-switch.ts`

`startViewAs` / `exitViewAs` keep their `actual_role !== "admin"` and
`isViewAsRole` pre-checks, then call `rpc("view_as_transition", …)` through the
service-role client. No audit calls remain in TS. P0074 → the existing
"Only an admin…" message; any other error → the existing generic message.
Results gain the new state: `{ ok: true; role: ViewAsRole | null }`.

### 2b. Lazy expiry — `requireSignedInStaff` (item 12)

After loading the profile: if `profile.role === "admin"`, `view_as_role` is
set, and `activeViewAs(profile)` is null (stale), call `view_as_expire` via the
service-role client with the request's IP/UA. Errors are reported
(`reportError`, scope `view-as.expire`) and never thrown — the session is
already correct without the cleanup. This runs at most once per stale row in
practice (the update clears the row).

### 2c. Server Actions — `view-as/actions.ts` (items 7, 8)

Both actions take the `useActionState` shape `(prev: ViewAsActionState,
formData) => Promise<ViewAsActionState>` where `ViewAsActionState = { error:
string | null }`.

- Failure → `reportError` (as today) and return `{ error }`; no redirect.
- Success → `revalidatePath("/staff", "layout")` then
  `redirect(safeReturnTo(formData.get("return_to"), newEffectiveRole))`.

### 2d. `safeReturnTo(raw, role)` — new `src/lib/auth/view-as-return.ts` (item 7)

Pure, client-safe. Returns `/staff` unless all of:

- `raw` is a string that starts with `/staff` and contains no `\` and does not
  start with `//`;
- `new URL(raw, "https://x.invalid")` keeps origin `https://x.invalid` and its
  pathname is `/staff` or starts with `/staff/`;
- the pathname is `/staff`, or some section of `visibleNavFor(role)` satisfies
  `isSectionActive(section, pathname)` (flat items and subgroups; prefix match, so
  detail pages under a listed page count). Pages no sidebar item owns fall back
  to `/staff` — acceptable, and never wrong.

Returns pathname + search (hash dropped). The page's own server guard stays the
backstop (admin-only pages already `redirect("/staff")` for other roles).

### 2e. State endpoint — `GET /staff/view-as/state` (item 5)

`src/app/(staff)/staff/(dashboard)/view-as/state/route.ts`: `requireActiveStaff()`
(which also runs 2b), returns `{ role: ViewAsRole | null, until: string | null }`
for the caller's own row, `Cache-Control: no-store`. A non-admin gets `{ role:
null, until: null }`.

## 3. Client

### 3a. `ViewAsSelect` (items 1, 7, 8)

- `useActionState(startViewAsAction, { error: null })`.
- The `<select>` keeps `defaultValue` and gets `key={`${current ?? "none"}:${until ?? ""}`}`
  from the parent so a new server state remounts it on the right value (item 1).
- Hidden `return_to` input, filled with `location.pathname + location.search`
  in the `onChange` handler just before `requestSubmit()`.
- While pending: select `disabled`, a "Switching…" note, `aria-busy`.
- `state.error` → `<p role="alert">` under the select.
- New prop `until: string | null` (for the key).

The Exit button moves into a small client component (`ViewAsExitButton`) with
the same `useActionState` + `return_to` + pending ("Exiting…") + error pattern.

### 3b. Banner (items 2, 6)

Props become `{ role, untilLabel, remainingMs }`: `untilLabel` is the server's
Manila clock time (`manilaTime(until)`, e.g. "6:12 PM" — the app’s canonical clock format) and `remainingMs` is
`Date.parse(until) - Date.now()` computed on the server.

- Copy: **Viewing as Reception until 6:12 PM** · 3h 40m left. Anything you save
  is recorded under your name.
- Countdown: on each new `remainingMs` prop the component stores a deadline of
  `performance.now() + remainingMs` and re-renders every 15 s with
  `formatRemainingMs(deadline - performance.now())`. The device's wall clock is
  never read.
- Expiry refresh: `setTimeout(router.refresh, max(remainingMs, 0) + 1000)`,
  keyed on `remainingMs`. Every refresh that finds the override still active
  delivers a new `remainingMs`, which re-arms the timer (item 2). A 1-second
  floor stops a hot loop.
- `formatRemaining(untilIso, now)` stays for server use; the arithmetic moves
  into `formatRemainingMs(ms)` which both call.

### 3c. Shell sync — `useViewAsShellSync(expected)` (item 5)

Replaces `useRefreshOnVisible`. Used by the banner (`expected = {role, until}`)
and by `RefreshOnFocus` (renamed `ViewAsShellSync`, `expected = null`) — i.e.
only for admins. Triggers: `usePathname()` changes (not the first render) and
`visibilitychange` → visible. On trigger it fetches `/staff/view-as/state`; if
the answer's `role`/`until` differ from `expected`, or the fetch fails or
returns non-JSON (e.g. redirected to login), it calls `router.refresh()`.
In-flight requests are aborted when a newer trigger fires.

### 3d. Mobile drawer (item 4)

`StaffMobileNavTrigger` closes the drawer in an effect keyed on the View-as
state it receives (`viewAs?.role`, `viewAs?.until`) — i.e. after a successful
switch re-renders the shell. A failed switch leaves the drawer open with the
select's error visible. The drawer's `ViewAsSelect` gets the new `until` prop.

## 4. Staff Users readout (item 11)

`/staff/users` (already admin-only via `requireAdminStaff`) loads
`staff_profiles` rows with `role = 'admin' and view_as_until > now()` through
the admin client it already uses.

- A "Active role views" `Panel` above the users table: one line per admin —
  name, "viewing as <Role>", "until <Manila time> (<left>)". When none: one
  muted line, "No one is viewing the app as another role."
- In the users table, those admins' role cell gets a small amber chip
  "Viewing as <Role>".

Admins who are *themselves* simulating cannot open the page (effective role is
not admin), which is correct.

## 5. Tests

Vitest:
- `view-as-return.test.ts` — accepts `/staff/visits/…?x=1` for reception;
  rejects `//evil`, `/staff\\evil`, `https://…`, `/staffx`, `/patients`, admin-only
  paths for reception; `/staff` always allowed; hash dropped.
- `view-as.test.ts` — `formatRemainingMs` edges.
- `view-as-switch.test.ts` — rewritten: calls `view_as_transition` with the right
  args; maps P0074; no TS audit calls.
- `require-staff` — stale admin row calls `view_as_expire` once; active or
  non-admin rows never do; an rpc error does not throw.
- `view-as-migration.test.ts` — 0187's `interval '4 hours'` equals
  `VIEW_AS_DURATION_MS`; the trigger's CASE matches 0182's.
- `view-as-select` — remount on new `current`/`until`; pending disables; error
  renders; `return_to` filled from location.
- `view-as-banner.test.tsx` — countdown ticks with fake timers while
  `Date.now` is skewed; timer re-arms on a new `remainingMs`; absolute label shown.
- `useViewAsShellSync` — refresh only on mismatch/failure; fires on pathname
  change, not on first render.
- `staff-mobile-nav-trigger.test.tsx` — drawer closes when `viewAs` changes,
  stays open when it does not.
- Staff Users readout render test (if the page's existing test harness allows;
  otherwise a pure `activeRoleViews` helper test).

DB smoke:
- `supabase/tests/0182_staff_view_as_smoke.sql` + **P8** Pathologist equivalence
  (A-as-pathologist sees exactly what genuine pathologist P sees on a
  pathologist-gated relation) + **P9** Claim write: as A-as-xray, the
  `update test_requests set status='in_progress', assigned_to=…` on an x-ray line
  affects 1 row exactly as for genuine X. Each mutation-checked (break the
  fixture/override and watch it fail).
- New `supabase/tests/0187_view_as_followups_smoke.sql`: transition sequences
  (start → switch → exit = started, ended:switched, started, ended:manual);
  double exit logs once; start over an expired row logs `ended:expired` then
  `started`; `view_as_expire` twice → one row; non-admin → P0074; trigger stamps
  a staff row while active, not after exit, not a `staff.view_as.*` row, not a
  patient row, and leaves non-object metadata alone; ACLs closed. Mutation-checked.

Browser (local, Playwright): the #237 checklist items that touch changed code,
plus: picker shows the new role after a switch; return to an allowed page / fall
back from an admin page; forced failure shows the error; drawer closes on phone
width; banner shows "until …" and ticks; Staff Users readout.

## 6. Docs

- Parent spec §Audit: replace "Expiry writes no event" with the lazy
  `ended:expired` rule (first request after expiry, or the next start/exit).
- Guide §5.8 "Seeing the app as another role": until-time + countdown, return to
  page, error message, the expired audit row, `acting_as` on audit rows, the
  Staff Users readout. Fix the duplicate "5.8" numbering (Books & payroll vs
  View-as). Bump to the next free version (v2.33 unless main moved).
- CLAUDE.md migration ledger: 0187.

## Follow-up ideas (not in this PR)

- "End now" on the Active role views panel (one admin ends another's view,
  reason `ended_by_admin`).
- An `acting_as` filter/column in the audit log viewer.
