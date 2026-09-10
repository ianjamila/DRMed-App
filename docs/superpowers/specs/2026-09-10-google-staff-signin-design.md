# Google sign-in for staff — design

**Date:** 2026-09-10
**Branch:** `feat/google-staff-signin` off `origin/main` (`47c07ba`)
**Migration:** none — prod stays at **0136**

## Problem

0 of 10 staff have two-step sign-in. The reason is not reluctance: the MFA gate
in `require-staff.ts` is disabled outright in production
(`FEATURE_STAFF_MFA_REQUIRED=false` on Vercel, confirmed 2026-09-10), so nobody
has ever been prompted. Staff sign in with an email and a password, single
factor.

Enabling the existing TOTP gate is not safe as it stands. Nothing in the app can
unenroll a verified factor — not the user, not an admin — so a lost phone is a
permanent lockout needing Supabase-project access. `requireActiveStaff()` makes
aal2 **mandatory** for the admin role, and there is exactly one real human admin
(Ian Jamila; `Test Admin` and `Legacy Import` are a test and a system account).
An admin-only reset cannot rescue the only admin.

## Decision

Replace the TOTP-first plan with **Google sign-in for staff**, modelled on the
eaglewatch project. Every real human staff account already uses a Gmail address,
so Google covers 100% of actual users, delivers whatever 2FA those accounts
carry, and moves account recovery to Google — where it is somebody else's
problem and there is no factor to lose.

Email + password stays as a **break-glass** route.

An earlier design in this same session (admin MFA reset + self-service
authenticator replace) is **superseded and will not be built**. There is no TOTP
secret to lose.

### Decisions taken with the user

| Question | Decision |
|---|---|
| Scope | Google sign-in for **all staff**, not just admins |
| Freya's account | Change her existing auth user's email to `freyadylimx@gmail.com`, preserving her user id |
| Password sign-in | **Keep** as break-glass |
| Google Workspace | Mixed/personal accounts — **no `hd` domain restriction** |
| MFA gate | Drop forced enrolment; TOTP becomes opt-in for everyone (see "The gate") |

## Facts established before designing

These cost real effort to establish. Do not re-derive them.

1. **Existing accounts will link, not duplicate.** All five real auth users have
   `email_confirmed_at` set and exactly one `email` identity. Google always
   returns verified emails, so Supabase attaches the Google identity to the
   **existing** user — same `id`. Every `staff_profiles` row, role and
   `audit_log` row survives untouched.
2. **Patients are not Supabase auth users.** They sign in with DRM-ID + PIN
   against a minted anon-role JWT (`src/lib/supabase/patient.ts`). `auth.users`
   is staff-only (12 rows). Cleaning up an unknown auth user therefore cannot
   touch a patient.
3. **`staff_profiles.id` IS `auth.users.id`** (FK, `on delete cascade`), so
   deleting an auth user cascades the profile away and breaks audit-name
   resolution. Any delete must be hard-guarded.
4. **`requireSignedInStaff()` already is the authorization gate.** It refuses
   anyone without an active, non-deleted `staff_profiles` row, audits
   `staff.signin.rejected_inactive`, signs them out and redirects to
   `/staff/login`.
5. **Supabase's authorize endpoint does not validate `redirect_to`.** Verified
   with a control request: a bogus `redirect_to` is echoed back unchanged. The
   allowlist is enforced later, at Supabase's own `/auth/v1/callback`. A trace of
   the authorize endpoint therefore proves nothing about the allowlist.
6. **Verified by redirect trace 2026-09-10:** the Google provider is enabled and
   the client ID is saved (`302 → accounts.google.com`, not `Unsupported
   provider`); Google accepts the client and its registered redirect URI
   (`302 → /v3/signin/identifier`, no `redirect_uri_mismatch`). Still unverified
   until one real sign-in: the redirect allowlist, the publishing status
   (Testing vs Production), and the client secret.
7. **DRMed has no `middleware.ts`**, though `src/lib/supabase/server.ts` carries
   a comment claiming middleware handles session refresh. Pre-existing; see
   "Deliberately out of scope".

## Why DRMed does not copy eaglewatch's gate

Eaglewatch has no allowlist. A trigger on `auth.users` creates a `profiles` row
at `status='pending'` for anyone who signs in with Google, then matches them to
an `employees` row by email; unmatched people sit parked on `/pending`, still
authenticated.

DRMed needs none of that. Admins already pre-create the auth user
(`createStaffUserAction` → `admin.auth.admin.createUser` → insert
`staff_profiles` with that id), and fact 4 above means the gate already exists
and is stricter than eaglewatch's. The flow is simply:

> admin provisions the staff user with their Gmail → that person clicks
> "Continue with Google" → Supabase links the identity to the pre-created
> account by confirmed-email match → `staff_profiles` row found → in.

No trigger, no pending state, no new table, no migration.

**Two eaglewatch behaviours are deliberately not copied:**

- Its callback validates `next` with `next.startsWith('/')`, which lets
  `//evil.com` through as a scheme-relative URL. DRMed validates against a path
  shape instead.
- Its `getClaims` + embedded-JWKS optimisation exists to survive a specific Auth
  outage. Unnecessary complexity here; use `getUser()`.

## The gate

`require-staff.ts` currently reads:

```ts
const needsMfa =
  mfaRequired &&
  (session.role === "admin"
    ? aal.currentLevel !== "aal2"
    : aal.nextLevel === "aal2" && aal.currentLevel !== "aal2");
```

The admin branch forces enrolment. **Drop it**, so every role follows the rule
non-admins already follow: *if you have a verified factor, you must use it; if
you have not, you are in.*

```ts
const needsMfa =
  mfaRequired && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2";
```

Consequences:
- Nobody is ever force-marched into TOTP — the "no more MFA hassle" requirement.
- Google sign-in needs no inspection of *how* the session was authenticated.
- Anyone who wants TOTP on their password login can still enrol at `/staff/mfa`
  and it is enforced.
- `FEATURE_STAFF_MFA_REQUIRED` can be set back to `true` in production, where it
  now means "enforce factors people opted into" rather than "force enrolment".

**Rejected alternative:** exempt Google sessions specifically by reading `oauth`
out of the session's `amr` claim (`getAuthenticatorAssuranceLevel()` returns
`currentAuthenticationMethods`; `"oauth"` is a valid `AMRMethod`). Stronger
posture — TOTP stays mandatory on the password route — but it depends on the
claim surviving a token refresh, which is unverified. If it does not, an admin
is bounced to the enrolment page mid-session.

**Cost, stated plainly:** the break-glass password route is single factor for an
admin unless they opt in. It is rate-limited per-IP and per-email and audited,
and Google is the normal route, but it is a real trade.

## Build

| Piece | File |
|---|---|
| Callback decision logic, deps-injected | `src/lib/auth/oauth-callback.ts` *(new)* |
| Redirect-path validation | `src/lib/auth/safe-redirect.ts` *(new)* |
| OAuth callback route | `src/app/auth/callback/route.ts` *(new)* |
| "Continue with Google" button | `staff/login/login-form.tsx`, `staff/login/page.tsx` (error banner) |
| Gate policy | `src/lib/auth/require-staff.ts` |
| Admin can change a staff email | `users/actions.ts`, `staff-form.tsx`, `validations/staff-user.ts` |
| Copy correction | `staff/mfa/enroll-form.tsx` |

### The callback route

`src/app/auth/callback/route.ts`, a Route Handler (it can set cookies; a Server
Component cannot).

1. Read `code` and `next` from the query string.
2. No `code` → audit `staff.signin.failed` with `{ provider: "google", reason:
   "no_code" }`, redirect `/staff/login?error=auth_failed`.
3. `exchangeCodeForSession(code)`. On error → same audit shape with the real
   reason, same redirect.
4. Resolve the `staff_profiles` row for the authenticated user.
   - **Active row** → audit `staff.signin.success` with `{ provider: "google" }`,
     reusing the existing action key so audit filters keep working. Redirect to
     the validated `next`, default `/staff`.
   - **No row / inactive / soft-deleted** → audit
     `staff.signin.rejected_unknown` with the attempted email and whether a
     profile existed, `signOut()`, redirect `/staff/login?error=not_staff`.
5. **Orphan cleanup.** Delete the `auth.users` row only when **no
   `staff_profiles` row exists at all, soft-deleted ones included** (fact 3).
   An inactive or soft-deleted staff member's auth user is never deleted.

### Redirect validation

`next` must be a site-relative path: begins with a single `/`, does **not**
begin with `//` or `/\`, contains no scheme, no `..` segment and no control
characters. Anything else falls back to `/staff`. Unit-tested against the
eaglewatch bypass (`//evil.com`) explicitly.

### The login page

A "Continue with Google" button above the existing password form, calling
`signInWithOAuth({ provider: "google", options: { redirectTo:
`${window.location.origin}/auth/callback` } })` from the browser client. No
`queryParams`, no `hd`, no extra scopes — matching eaglewatch. The password form
stays, presented as the secondary route.

`?error=` values render an inline banner: `auth_failed` (sign-in did not
complete) and `not_staff` (that Google account is not a staff account).

### Admin email change

Today the edit form disables the email field and says *"Email cannot be changed
here. Contact Supabase support if needed."* — which is untrue, and becomes
load-bearing under Google sign-in: matching is by email, so a staff member
changing their Gmail silently breaks their access.

Add it to the existing edit page, matching the house pattern for an admin acting
on another staff member (`requireAdminStaff` → refuse self → verify target row
→ mutate → audit → revalidate):

- `admin.auth.admin.updateUserById(id, { email, email_confirm: true })` —
  confirmed instantly, no verification round-trip, user id preserved.
- Reject an email already in use by another auth user, with a clear message.
- Audit `staff_user.email_changed` with `{ target_name, old_email, new_email }`.

Freya's move to `freyadylimx@gmail.com` is then done through the UI, not
hardcoded.

## Testing

Unit tests, deps injected, no DB — matching `recordSelfRegistrationGrant` in
`src/lib/consent/self-registration.ts`.

`oauth-callback.ts`:
- no code → failure audit, no session
- exchange error → failure audit carries the real reason
- active profile → success audit carries `provider: "google"`
- no profile → rejection audit, sign-out, **and** orphan delete
- inactive profile → rejection audit, sign-out, **and no delete**
- soft-deleted profile → rejection audit, sign-out, **and no delete**
- delete is never called while any `staff_profiles` row exists

`safe-redirect.ts`: `/staff/x` passes; `//evil.com`, `/\evil.com`,
`https://evil.com`, `/a/../../b`, a control character, and an empty value all
fall back to `/staff`.

`require-staff.ts`: admin with no factor is **not** redirected; admin with a
verified factor at aal1 **is**; flag `false` disables both.

Email change: rejects self-target, rejects a duplicate email, audits with both
old and new values.

## Configuration (outside the code)

1. **Google Cloud Console** — OAuth 2.0 Web client. Authorized redirect URI is
   Supabase's, not the app's:
   `https://qhptbmafrosgibooelpp.supabase.co/auth/v1/callback`. Authorized
   JavaScript origins empty. **Done** (verified by trace).
2. **Supabase → Auth → Providers → Google** — enabled, client ID + secret saved.
   **Done** for the ID; the secret is unverified until a real sign-in.
3. **Supabase → Auth → URL Configuration** — Site URL `https://drmed.ph`;
   redirect allowlist must contain `https://drmed.ph/auth/callback` and
   `http://localhost:3000/auth/callback`. **Unverified.**
4. **Google Auth Platform → Audience** — publishing status must be *In
   production*, not *Testing*. In Testing, only listed test users can sign in and
   sessions expire weekly. Scopes are non-sensitive, so publishing needs no
   Google review. **Unverified.**
5. **Vercel** — `FEATURE_STAFF_MFA_REQUIRED` is `false` today. After this ships
   it can be set to `true`.

Items 3 and 4, plus the client secret, are all settled by one real Google
sign-in once the callback route exists.

## Deliberately out of scope

- **`middleware.ts` for session refresh.** DRMed has none; Server Components
  cannot set cookies, so a session past the 1-hour JWT expiry on
  Server-Component-only pages can fail to refresh. Pre-existing, not caused by
  this change, and it deserves its own PR.
- **The guide.** `docs/drmed-user-guide.html` is at v2.1 / migration 0133 and
  describes password sign-in and the MFA gate. Its MFA passages (2.2, 5.4, ch 8)
  become wrong when this merges. Correct **only those passages** here; the
  version and migration-header bump belong to the separate guide-update task.
- **The `@drmed.ph` test accounts** (`admin@`, `reception@`, `inactive@`) stay
  password-only. That is what break-glass is for.
- **Recovery codes**, **admin MFA reset**, **self-service authenticator
  replace** — all superseded.
