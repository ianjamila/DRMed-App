# Google Staff Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let DRMed staff sign in with their Google account, keep email + password as a break-glass route, and stop forcing anyone into TOTP enrolment.

**Architecture:** A new Route Handler at `/auth/callback` exchanges the OAuth code and then reuses the authorization gate DRMed already has — an active `staff_profiles` row keyed by `auth.users.id`. All decision logic lives in two pure, dependency-injected modules (`safe-redirect.ts`, `oauth-callback.ts`) so it unit-tests with no Supabase and no Next runtime. No migration: prod stays at **0136**.

**Tech Stack:** Next.js 16 (App Router, Route Handlers), `@supabase/ssr` + `@supabase/supabase-js` 2.106, Zod, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-10-google-staff-signin-design.md`

---

## File Structure

**Create:**
- `src/lib/auth/safe-redirect.ts` — validates a post-login `next` path. Pure.
- `src/lib/auth/safe-redirect.test.ts`
- `src/lib/auth/mfa-gate.ts` — the "does this session still owe a factor?" predicate. Pure.
- `src/lib/auth/mfa-gate.test.ts`
- `src/lib/auth/oauth-callback.ts` — the whole callback decision, deps injected. Pure.
- `src/lib/auth/oauth-callback.test.ts`
- `src/app/auth/callback/route.ts` — wires the real Supabase clients into the above.
- `src/app/(staff)/staff/login/google-button.tsx` — client component.

**Modify:**
- `src/lib/auth/require-staff.ts` — use `needsMfaChallenge`, drop the admin-forces-enrolment branch.
- `src/app/(staff)/staff/login/page.tsx` — error banner from `?error=`.
- `src/app/(staff)/staff/login/login-form.tsx` — demote to the secondary route.
- `src/lib/validations/staff-user.ts` — `StaffEmailChangeSchema`.
- `src/app/(staff)/staff/(dashboard)/users/actions.ts` — `changeStaffEmailAction`.
- `src/app/(staff)/staff/(dashboard)/users/[id]/edit/page.tsx` — mount the new panel.
- `src/app/(staff)/staff/(dashboard)/users/[id]/edit/email-form.tsx` — new client form.
- `src/app/(staff)/staff/mfa/enroll-form.tsx` — correct the false "recovery contact" copy.
- `docs/drmed-user-guide.html` — MFA passages only.

**Why this split:** the three `src/lib/auth/*.ts` modules are pure and hold every branch worth testing; the route handler and the forms stay thin adapters. That keeps the security-relevant logic in files small enough to hold in context, and testable without mocking Next.

---

## Task 1: Safe redirect path

**Files:**
- Create: `src/lib/auth/safe-redirect.ts`
- Test: `src/lib/auth/safe-redirect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/safe-redirect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps a staff path", () => {
    expect(safeRedirectPath("/staff/visits/queue?stage=processing")).toBe(
      "/staff/visits/queue?stage=processing",
    );
  });

  it("keeps the bare staff root", () => {
    expect(safeRedirectPath("/staff")).toBe("/staff");
  });

  // eaglewatch's callback uses `next.startsWith("/")`, which lets this through:
  // browsers read "//host" as scheme-relative and navigate off-site.
  it("rejects a scheme-relative URL", () => {
    expect(safeRedirectPath("//evil.example.com/staff")).toBe("/staff");
  });

  it("rejects a backslash variant", () => {
    expect(safeRedirectPath("/\\evil.example.com")).toBe("/staff");
  });

  it("rejects an absolute URL", () => {
    expect(safeRedirectPath("https://evil.example.com/staff")).toBe("/staff");
  });

  it("rejects traversal out of /staff", () => {
    expect(safeRedirectPath("/staff/../../etc")).toBe("/staff");
  });

  it("rejects a path outside /staff", () => {
    expect(safeRedirectPath("/portal/results")).toBe("/staff");
  });

  it("rejects a prefix that only looks like /staff", () => {
    expect(safeRedirectPath("/staffing-agency")).toBe("/staff");
  });

  it("rejects control characters", () => {
    expect(safeRedirectPath("/staff/a\nb")).toBe("/staff");
  });

  it.each([null, undefined, ""])("falls back for %s", (value) => {
    expect(safeRedirectPath(value)).toBe("/staff");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/safe-redirect.test.ts`
Expected: FAIL — `Failed to resolve import "./safe-redirect"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/auth/safe-redirect.ts`:

```ts
// Where a staff member lands after signing in. Every post-login redirect goes
// through here: the value arrives on the query string, so it is attacker-
// controlled and must never be able to leave the site.
//
// The allowlist is deliberately narrow — /staff and below is the only place a
// signed-in staff member has any business landing.
const DEFAULT_PATH = "/staff";

export function safeRedirectPath(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0) return DEFAULT_PATH;

  // Must be inside the staff area. This single check also rejects "//host"
  // (scheme-relative, which browsers navigate off-site) and any absolute URL.
  if (next !== "/staff" && !next.startsWith("/staff/")) return DEFAULT_PATH;

  // Some browsers normalise "\" to "/", so a backslash can smuggle a host.
  if (next.includes("\\")) return DEFAULT_PATH;

  // "/staff/../.." escapes the prefix check above once the browser resolves it.
  if (next.split(/[/?#]/).includes("..")) return DEFAULT_PATH;

  // CR/LF/NUL and friends can split a header or truncate a URL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_PATH;

  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/safe-redirect.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/safe-redirect.ts src/lib/auth/safe-redirect.test.ts
git commit -m "feat(auth): validate the post-login redirect path"
```

---

## Task 2: The MFA gate predicate

Extracts the branch from `require-staff.ts` so it is testable, and drops the rule that forces admins to enrol.

**Files:**
- Create: `src/lib/auth/mfa-gate.ts`
- Test: `src/lib/auth/mfa-gate.test.ts`
- Modify: `src/lib/auth/require-staff.ts:78-98`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/mfa-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { needsMfaChallenge } from "./mfa-gate";

describe("needsMfaChallenge", () => {
  it("challenges a user who has enrolled but has not yet used their factor", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal1",
        nextLevel: "aal2",
      }),
    ).toBe(true);
  });

  it("lets an enrolled user through once they have cleared the challenge", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal2",
        nextLevel: "aal2",
      }),
    ).toBe(false);
  });

  // The behaviour change: enrolment is opt-in for EVERY role, admin included.
  // Nobody can be locked out by a lost phone they were forced to enrol.
  it("never forces enrolment on a user with no factor", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal1",
        nextLevel: "aal1",
      }),
    ).toBe(false);
  });

  it("is disabled wholesale by the feature flag", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: false,
        currentLevel: "aal1",
        nextLevel: "aal2",
      }),
    ).toBe(false);
  });

  it("stays out of the way when the assurance level is unknown", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: null,
        nextLevel: null,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/mfa-gate.test.ts`
Expected: FAIL — `Failed to resolve import "./mfa-gate"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/auth/mfa-gate.ts`:

```ts
// Does this session still owe a second factor?
//
// One rule for every role: if you have a verified factor you must use it; if
// you have not enrolled one, you are in. Supabase sets nextLevel to "aal2"
// exactly when a verified factor exists, so that field IS the enrolment check.
//
// Enrolment is opt-in on purpose. Nothing in the app can unenroll a verified
// factor, so forcing anyone to enrol makes a lost phone a permanent lockout.
// Staff get their second factor from Google sign-in instead.
export function needsMfaChallenge(input: {
  mfaRequired: boolean;
  currentLevel: string | null;
  nextLevel: string | null;
}): boolean {
  return (
    input.mfaRequired &&
    input.nextLevel === "aal2" &&
    input.currentLevel !== "aal2"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/mfa-gate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Adopt it in `require-staff.ts`**

In `src/lib/auth/require-staff.ts`, add to the imports at the top:

```ts
import { needsMfaChallenge } from "@/lib/auth/mfa-gate";
```

Then replace the whole comment block and body of `requireActiveStaff` (currently lines 68-98) with:

```ts
// Call at the top of any protected /staff/* server component.
// Verifies basic auth (delegated to requireSignedInStaff) AND enforces MFA
// for anyone who has enrolled a factor. Enrolment itself is opt-in for every
// role — see needsMfaChallenge for why.
//
// FEATURE_STAFF_MFA_REQUIRED env var (default "true"): when set to "false",
// the MFA gate is fully disabled. Intended for UAT environments.
export async function requireActiveStaff(): Promise<StaffSession> {
  const session = await requireSignedInStaff();
  const supabase = await createClient();
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (!aal) return session;

  if (
    needsMfaChallenge({
      mfaRequired: process.env.FEATURE_STAFF_MFA_REQUIRED !== "false",
      currentLevel: aal.currentLevel,
      nextLevel: aal.nextLevel,
    })
  ) {
    redirect("/staff/mfa");
  }

  return session;
}
```

- [ ] **Step 6: Verify nothing else referenced the old behaviour**

Run: `grep -rn "currentLevel\|nextLevel" src/ --include="*.ts" --include="*.tsx"`
Expected: hits only in `src/lib/auth/mfa-gate.ts`, `src/lib/auth/mfa-gate.test.ts` and `src/lib/auth/require-staff.ts`. `src/app/(staff)/staff/mfa/page.tsx` uses `currentLevel` too — leave it alone, its aal2-redirect is still correct.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Baseline was 1045 tests; expect 1045 + 17 = 1062.

- [ ] **Step 8: Commit**

```bash
git add src/lib/auth/mfa-gate.ts src/lib/auth/mfa-gate.test.ts src/lib/auth/require-staff.ts
git commit -m "feat(auth): make TOTP enrolment opt-in for every role"
```

---

## Task 3: The OAuth callback decision

Every branch of the callback, with no Supabase and no Next imports.

**Files:**
- Create: `src/lib/auth/oauth-callback.ts`
- Test: `src/lib/auth/oauth-callback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/oauth-callback.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  handleOAuthCallback,
  type OAuthCallbackDeps,
  type StaffProfileRow,
} from "./oauth-callback";

const ACTIVE: StaffProfileRow = {
  id: "u-1",
  full_name: "Ian Jamila",
  is_active: true,
  deleted_at: null,
};

function makeDeps(over: Partial<OAuthCallbackDeps> = {}): OAuthCallbackDeps {
  return {
    exchangeCode: vi
      .fn()
      .mockResolvedValue({ userId: "u-1", email: "a@b.com", error: null }),
    loadProfile: vi.fn().mockResolvedValue(ACTIVE),
    signOut: vi.fn().mockResolvedValue(undefined),
    deleteAuthUser: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const INPUT = { code: "abc", next: null, ip: "203.0.113.9", userAgent: "vitest" };

describe("handleOAuthCallback", () => {
  it("signs in an active staff member and audits the provider", async () => {
    const deps = makeDeps();
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out).toEqual({ kind: "success", redirectTo: "/staff" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: "u-1",
        actor_type: "staff",
        action: "staff.signin.success",
        metadata: { provider: "google" },
        ip_address: "203.0.113.9",
        user_agent: "vitest",
      }),
    );
    expect(deps.signOut).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("honours a safe next path", async () => {
    const out = await handleOAuthCallback(
      { ...INPUT, next: "/staff/visits" },
      makeDeps(),
    );
    expect(out).toEqual({ kind: "success", redirectTo: "/staff/visits" });
  });

  it("refuses to redirect off-site", async () => {
    const out = await handleOAuthCallback(
      { ...INPUT, next: "//evil.example.com" },
      makeDeps(),
    );
    expect(out).toEqual({ kind: "success", redirectTo: "/staff" });
  });

  it("fails closed when Google sent no code", async () => {
    const deps = makeDeps();
    const out = await handleOAuthCallback({ ...INPUT, code: null }, deps);

    expect(out).toEqual({ kind: "failed", redirectTo: "/staff/login?error=auth_failed" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        actor_type: "anonymous",
        action: "staff.signin.failed",
        metadata: { provider: "google", reason: "no_code" },
      }),
    );
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("reports the real reason when the exchange fails", async () => {
    const deps = makeDeps({
      exchangeCode: vi
        .fn()
        .mockResolvedValue({ userId: null, email: null, error: "invalid flow state" }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("failed");
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.failed",
        metadata: { provider: "google", reason: "invalid flow state" },
      }),
    );
  });

  it("rejects a Google account with no staff profile AND deletes the orphan", async () => {
    const deps = makeDeps({ loadProfile: vi.fn().mockResolvedValue(null) });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out).toEqual({ kind: "rejected", redirectTo: "/staff/login?error=not_staff" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff.signin.rejected_unknown",
        metadata: { provider: "google", email: "a@b.com", has_profile: false },
      }),
    );
    expect(deps.signOut).toHaveBeenCalled();
    expect(deps.deleteAuthUser).toHaveBeenCalledWith("u-1");
  });

  // staff_profiles.id cascades from auth.users, so deleting the auth user of a
  // real staff member would take their profile — and every audit row's name
  // resolution — with it.
  it("rejects an inactive staff member WITHOUT deleting them", async () => {
    const deps = makeDeps({
      loadProfile: vi.fn().mockResolvedValue({ ...ACTIVE, is_active: false }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("rejected");
    expect(deps.signOut).toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("rejects a soft-deleted staff member WITHOUT deleting them", async () => {
    const deps = makeDeps({
      loadProfile: vi
        .fn()
        .mockResolvedValue({ ...ACTIVE, deleted_at: "2026-01-01T00:00:00Z" }),
    });
    const out = await handleOAuthCallback(INPUT, deps);

    expect(out.kind).toBe("rejected");
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("records that a profile existed when rejecting an inactive user", async () => {
    const deps = makeDeps({
      loadProfile: vi.fn().mockResolvedValue({ ...ACTIVE, is_active: false }),
    });
    await handleOAuthCallback(INPUT, deps);

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { provider: "google", email: "a@b.com", has_profile: true },
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/oauth-callback.test.ts`
Expected: FAIL — `Failed to resolve import "./oauth-callback"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/auth/oauth-callback.ts`:

```ts
import { safeRedirectPath } from "./safe-redirect";

// The whole OAuth callback decision, with its dependencies injected so every
// branch is unit-testable without Supabase or Next. The Route Handler at
// src/app/auth/callback/route.ts supplies the real implementations.

export interface StaffProfileRow {
  id: string;
  full_name: string;
  is_active: boolean;
  deleted_at: string | null;
}

export interface OAuthAuditEntry {
  actor_id: string | null;
  actor_type: "staff" | "anonymous";
  action: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
}

export interface OAuthCallbackDeps {
  exchangeCode: (code: string) => Promise<{
    userId: string | null;
    email: string | null;
    error: string | null;
  }>;
  /** Returns the row in ANY state (inactive, soft-deleted), or null if none exists. */
  loadProfile: (userId: string) => Promise<StaffProfileRow | null>;
  signOut: () => Promise<void>;
  deleteAuthUser: (userId: string) => Promise<void>;
  audit: (entry: OAuthAuditEntry) => Promise<void>;
}

export type OAuthCallbackOutcome =
  | { kind: "success"; redirectTo: string }
  | { kind: "failed"; redirectTo: string }
  | { kind: "rejected"; redirectTo: string };

const FAILED = "/staff/login?error=auth_failed";
const NOT_STAFF = "/staff/login?error=not_staff";

export async function handleOAuthCallback(
  input: {
    code: string | null;
    next: string | null;
    ip: string | null;
    userAgent: string | null;
  },
  deps: OAuthCallbackDeps,
): Promise<OAuthCallbackOutcome> {
  const base = { ip_address: input.ip, user_agent: input.userAgent };

  async function fail(reason: string): Promise<OAuthCallbackOutcome> {
    await deps.audit({
      actor_id: null,
      actor_type: "anonymous",
      action: "staff.signin.failed",
      metadata: { provider: "google", reason },
      ...base,
    });
    return { kind: "failed", redirectTo: FAILED };
  }

  if (!input.code) return fail("no_code");

  const exchanged = await deps.exchangeCode(input.code);
  if (exchanged.error || !exchanged.userId) {
    return fail(exchanged.error ?? "exchange_failed");
  }

  const userId = exchanged.userId;
  const profile = await deps.loadProfile(userId);
  const allowed = !!profile && profile.is_active && profile.deleted_at === null;

  if (!allowed) {
    await deps.audit({
      actor_id: userId,
      actor_type: "staff",
      action: "staff.signin.rejected_unknown",
      metadata: {
        provider: "google",
        email: exchanged.email,
        has_profile: !!profile,
      },
      ...base,
    });
    await deps.signOut();

    // Only ever delete an auth user that has NO staff_profiles row at all.
    // staff_profiles.id references auth.users ON DELETE CASCADE, so deleting a
    // real staff member's auth user would drop their profile and break every
    // audit row that resolves actor_id -> name.
    if (!profile) await deps.deleteAuthUser(userId);

    return { kind: "rejected", redirectTo: NOT_STAFF };
  }

  await deps.audit({
    actor_id: userId,
    actor_type: "staff",
    action: "staff.signin.success",
    metadata: { provider: "google" },
    ...base,
  });

  return { kind: "success", redirectTo: safeRedirectPath(input.next) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/oauth-callback.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/oauth-callback.ts src/lib/auth/oauth-callback.test.ts
git commit -m "feat(auth): OAuth callback decision logic"
```

---

## Task 4: The callback Route Handler

A Route Handler, not a page — only Route Handlers and Server Actions can set the session cookies that `exchangeCodeForSession` writes.

**Files:**
- Create: `src/app/auth/callback/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/auth/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { handleOAuthCallback } from "@/lib/auth/oauth-callback";

// Supabase redirects here after Google. Must be a Route Handler:
// exchangeCodeForSession writes session cookies, which a Server Component
// cannot do.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const supabase = await createClient();
  const admin = createAdminClient();
  const h = await headers();

  const outcome = await handleOAuthCallback(
    {
      code: searchParams.get("code"),
      next: searchParams.get("next"),
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: h.get("user-agent"),
    },
    {
      exchangeCode: async (code) => {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        return {
          userId: data?.user?.id ?? null,
          email: data?.user?.email ?? null,
          error: error?.message ?? null,
        };
      },
      loadProfile: async (userId) => {
        // Admin client: an unknown sign-in has no RLS grant on staff_profiles,
        // and we need to tell "no row" apart from "row you cannot see".
        const { data } = await admin
          .from("staff_profiles")
          .select("id, full_name, is_active, deleted_at")
          .eq("id", userId)
          .maybeSingle();
        return data ?? null;
      },
      signOut: async () => {
        await supabase.auth.signOut();
      },
      deleteAuthUser: async (userId) => {
        await admin.auth.admin.deleteUser(userId);
      },
      audit,
    },
  );

  return NextResponse.redirect(`${origin}${outcome.redirectTo}`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no output.

- [ ] **Step 3: Confirm the route exists locally**

Run: `npm run dev` in one terminal, then in another:
`curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 'http://localhost:3000/auth/callback'`
Expected: `307 http://localhost:3000/staff/login?error=auth_failed` — no `code`, so it fails closed. Stop the dev server afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/app/auth/callback/route.ts
git commit -m "feat(auth): add the Google OAuth callback route"
```

---

## Task 5: Continue with Google

**Files:**
- Create: `src/app/(staff)/staff/login/google-button.tsx`
- Modify: `src/app/(staff)/staff/login/page.tsx`
- Modify: `src/app/(staff)/staff/login/login-form.tsx:38-44`

- [ ] **Step 1: Write the button**

Create `src/app/(staff)/staff/login/google-button.tsx`:

```tsx
"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser has already navigated away, so reaching here at
    // all means the redirect never started.
    if (oauthError) {
      setError("Could not reach Google. Try again, or sign in with a password.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={signIn}
        disabled={pending}
        className="w-full"
      >
        {pending ? "Redirecting to Google…" : "Continue with Google"}
      </Button>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Mount it, with the error banner**

Replace the whole body of `src/app/(staff)/staff/login/page.tsx` with:

```tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StaffLoginForm } from "./login-form";
import { GoogleSignInButton } from "./google-button";

export const metadata = {
  title: "Staff sign in — drmed.ph",
};

const ERROR_COPY: Record<string, string> = {
  auth_failed: "That sign-in didn't complete. Please try again.",
  not_staff:
    "That Google account isn't set up as staff here. Ask an admin to add it, or sign in with your password.",
};

interface Props {
  searchParams: Promise<{ error?: string }>;
}

export default async function StaffLoginPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const message = error ? ERROR_COPY[error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Staff sign in</CardTitle>
          <CardDescription>
            For drmed.ph staff. Patients sign in at /portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {message ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {message}
            </p>
          ) : null}

          <GoogleSignInButton />

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-xs uppercase tracking-wider text-slate-500">
              or
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <StaffLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 3: Demote the password button**

In `src/app/(staff)/staff/login/login-form.tsx`, replace the submit button (currently lines 42-44):

```tsx
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
```

with:

```tsx
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Signing in…" : "Sign in with a password"}
      </Button>
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck clean; lint 0 errors + the 2 known pre-existing warnings (`admin-dashboard.tsx` `PlannedCard`, `validations/booking.ts:97` `serviceIds`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/login"
git commit -m "feat(auth): add Continue with Google to the staff login page"
```

---

## Task 6: Admin can change a staff email

Google matches on email, so a staff member changing their Gmail silently breaks sign-in. The edit form currently disables the field and says *"Contact Supabase support"*, which is untrue.

**Files:**
- Modify: `src/lib/validations/staff-user.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/users/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/users/[id]/edit/email-form.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/users/[id]/edit/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/users/staff-form.tsx:71-75`

- [ ] **Step 1: Add the schema**

In `src/lib/validations/staff-user.ts`, after `AdminResetPasswordSchema`, add:

```ts
export const StaffEmailChangeSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email."),
});
```

and alongside the other type exports at the bottom:

```ts
export type StaffEmailChangeInput = z.infer<typeof StaffEmailChangeSchema>;
```

- [ ] **Step 2: Add the action**

In `src/app/(staff)/staff/(dashboard)/users/actions.ts`, add `StaffEmailChangeSchema` to the existing import from `@/lib/validations/staff-user`, then append this action after `adminResetStaffPasswordAction`:

```ts
export type EmailChangeResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

// Staff sign in with Google, which matches on email — so a stale address here
// locks the person out. Confirmed immediately (email_confirm) because an admin
// is asserting it in person; the user id never changes, so staff_profiles and
// every audit row stay attached.
export async function changeStaffEmailAction(
  staffUserId: string,
  _prev: EmailChangeResult | null,
  formData: FormData,
): Promise<EmailChangeResult> {
  const session = await requireAdminStaff();

  if (session.user_id === staffUserId) {
    return {
      ok: false,
      error: "Use Personal → My profile to change your own email.",
    };
  }

  const parsed = StaffEmailChangeSchema.safeParse({
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  const { data: target } = await admin
    .from("staff_profiles")
    .select("id, full_name")
    .eq("id", staffUserId)
    .maybeSingle();
  if (!target) {
    return { ok: false, error: "Staff user not found." };
  }

  const { data: current } = await admin.auth.admin.getUserById(staffUserId);
  const oldEmail = current?.user?.email ?? null;
  if (oldEmail === parsed.data.email) {
    return { ok: false, error: "That is already this user's email." };
  }

  const { error: updateErr } = await admin.auth.admin.updateUserById(
    staffUserId,
    { email: parsed.data.email, email_confirm: true },
  );
  if (updateErr) {
    // Supabase rejects a duplicate address; surface it plainly rather than
    // leaking the raw Auth error.
    const duplicate = /already|registered|exists/i.test(updateErr.message);
    return {
      ok: false,
      error: duplicate
        ? "Another account already uses that email."
        : updateErr.message,
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.email_changed",
    resource_type: "staff_profile",
    resource_id: staffUserId,
    metadata: {
      target_name: target.full_name,
      old_email: oldEmail,
      new_email: parsed.data.email,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/users");
  revalidatePath(`/staff/users/${staffUserId}/edit`);

  return {
    ok: true,
    message: `Email changed to ${parsed.data.email}. They sign in with that Google account from now on.`,
  };
}
```

- [ ] **Step 3: Add the client form**

Create `src/app/(staff)/staff/(dashboard)/users/[id]/edit/email-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeStaffEmailAction, type EmailChangeResult } from "../../actions";

interface Props {
  staffUserId: string;
  currentEmail: string;
}

export function EmailForm({ staffUserId, currentEmail }: Props) {
  const action = changeStaffEmailAction.bind(null, staffUserId);
  const [state, formAction, pending] = useActionState<
    EmailChangeResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="email">New email</Label>
        <Input
          key={state?.ok ? "after-success" : "open"}
          id="email"
          name="email"
          type="email"
          required
          defaultValue={currentEmail}
          autoComplete="off"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          This is the Google account they sign in with. Changing it takes effect
          immediately and does not send a confirmation email.
        </p>
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      {state && state.ok ? (
        <p
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
        >
          {state.message}
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Change email"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Mount it on the edit page**

In `src/app/(staff)/staff/(dashboard)/users/[id]/edit/page.tsx`, add to the imports:

```tsx
import { EmailForm } from "./email-form";
```

and insert this block immediately after the closing `</Panel>` of the `StaffForm` block and before the "Reset password" `<div>`:

```tsx
      {!isSelf ? (
        <Panel className="mt-6 p-6">
          <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
            Sign-in email
          </h2>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Staff sign in with Google, matched on this address. Update it when
            someone changes the Google account they use.
          </p>
          <div className="mt-4">
            <EmailForm
              staffUserId={profile.id}
              currentEmail={userResp?.user?.email ?? ""}
            />
          </div>
        </Panel>
      ) : null}
```

- [ ] **Step 5: Correct the now-false copy on the main form**

In `src/app/(staff)/staff/(dashboard)/users/staff-form.tsx`, replace:

```tsx
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Email cannot be changed here. Contact Supabase support if needed.
          </p>
```

with:

```tsx
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Change the sign-in email in the “Sign-in email” panel below.
          </p>
```

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean; lint 0 errors + the same 2 warnings; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/validations/staff-user.ts "src/app/(staff)/staff/(dashboard)/users"
git commit -m "feat(users): let an admin change a staff member's sign-in email"
```

---

## Task 7: Correct the false MFA copy

Several places tell staff things that are not true — some already false today, the rest made false by this PR.

**Files:**
- Modify: `src/app/(staff)/staff/mfa/enroll-form.tsx:102-106`
- Modify: `docs/drmed-user-guide.html`
- Modify: `CLAUDE.md:28`

- [ ] **Step 1: Fix the enrolment copy**

`enroll-form.tsx` currently reads *"Save this somewhere safe — if you lose your authenticator and your recovery contact, an admin must reset MFA via the database."* There is no recovery contact anywhere in the codebase. Replace that `<p>` with:

```tsx
        <p className="mt-2">
          Save this somewhere safe. Two-step sign-in is optional — if you lose
          your authenticator, sign in with Google instead and ask an admin to
          clear the old factor.
        </p>
```

- [ ] **Step 2: Correct nine passages in the guide**

Apply these as **substring** replacements with a `.mjs` script that asserts each `old` matches **exactly once** — the memory file's safe-edit pattern. Do not use `perl -pi`, `python3` heredocs, or pass the prose through `node -e`; all three mangle this content. Substrings, not whole lines, so the surrounding HTML stays untouched.

**Do not** change the guide's version number or migration header — that belongs to the separate guide-update task.

**1 — §2.1, how to sign in (line ~398).**
`old`: `Enter your work email and password, then <kbd class="ui">Sign in</kbd>.`
`new`: `Click <kbd class="ui">Continue with Google</kbd> and pick your work Google account.`

**2 — §2.1, the same step's body (line ~398).**
`old`: `You land on the dashboard for your role.`
`new`: `You land on the dashboard for your role. Email and password still works below the divider, as a fallback for when Google is unavailable.`

**3 — §2.1, the "No reset link" note (line ~400).**
`old`: `There is no self-service <q>Forgot password</q> for staff. Ask an Admin to reset it under <kbd class="ui">Staff users</kbd>.`
`new`: `There is no self-service <q>Forgot password</q> for staff. If you sign in with Google, use Google's own account recovery. For the password fallback, ask an Admin to reset it under <kbd class="ui">Staff users</kbd>.`

**4 — §2.2, the summary (line ~405).**
`old`: `Required for Admins. Optional but recommended for everyone else, and once you have set it up it is always asked for.`
`new`: `Optional for every role, including Admins — signing in with Google already gives you your second step. Once you set it up it is always asked for on the password route.`

**5 — §2.2, the enrolment step (line ~407).**
`old`: ` Admins are sent to the same page automatically at sign-in until they enrol.`
`new`: `` (empty string — delete the sentence; it is no longer true.)

**6 — §2.2, the "Lost phone" stop note (line ~411).**
`old`: `Losing the phone locks you out until someone with access to the Supabase project clears the factor.`
`new`: `If you lose the phone, sign in with Google instead — that route does not ask for the code. Clearing the stale factor still needs someone with access to the Supabase project.`

**7 — §5.4-equivalent, the go-live checklist (line ~852).**
`old`: `Admins are sent to <code class="route">/staff/mfa</code> automatically. Everyone else starts it from`
`new`: `Nobody is sent there automatically. Start it from`

**8 — the same step's tail (line ~852).**
`old`: `Tell staff before they enrol that a lost authenticator cannot be reset from inside the app (2.2).`
`new`: `Tell staff before they enrol that a lost authenticator still cannot be cleared from inside the app — they would fall back to Google sign-in (2.2).`

**9 — chapter 8, "Lost authenticator phone" (line ~912).**
`old`: `There is nothing you can do in the app: no screen removes an enrolled authenticator, not even yours. Clearing the factor needs someone with access to the Supabase project.`
`new`: `Have them sign in with Google instead — that route does not ask for the code, so they are not locked out. No screen removes an enrolled authenticator, so clearing the stale factor still needs someone with access to the Supabase project.`

**10 — Known limitations (line ~1047).**
`old`: `<dt>A lost authenticator locks you out</dt><dd>Two-step sign-in can be set up from <b>My profile</b>, but nothing in the app can remove an enrolled authenticator afterwards`
`new`: `<dt>A lost authenticator cannot be cleared in the app</dt><dd>Google sign-in means this no longer locks anyone out, but nothing in the app can remove an enrolled authenticator`

**11 — chapter 8, the admin how-to list (line ~910), add a new entry.**
`old`: `<dt>Reset a password</dt>`
`new`: `<dt>Change someone's sign-in email</dt><dd>Staff users › open the user › <b>Sign-in email</b> › <kbd class="ui">Change email</kbd>. This is the Google account they sign in with, so keep it current. Takes effect immediately; no confirmation email is sent.</dd>
      <dt>Reset a password</dt>`

- [ ] **Step 3: Fix the stale migration ledger in CLAUDE.md**

Unrelated to this feature but wrong today, and it is the second time it has drifted (see the PR 5 lesson). `CLAUDE.md:28` reads `prod head = 0135`; prod is actually at **0136**.

`old`: `Migration ledger: **prod head = 0135**, repo↔prod in sync (2026-09-10).`
`new`: `Migration ledger: **prod head = 0136**, repo↔prod in sync (2026-09-10).`

- [ ] **Step 4: Verify no stale claim survives**

Run: `grep -rn -i "recovery contact\|Contact Supabase support\|Required for Admins\|sent to the same page automatically" docs/drmed-user-guide.html "src/app/(staff)/staff"`
Expected: **no hits.** (Do not grep for "locked out" — the corrected text legitimately says "no longer locks anyone out".)

Run: `grep -c "Continue with Google" docs/drmed-user-guide.html`
Expected: `1`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/mfa/enroll-form.tsx" docs/drmed-user-guide.html CLAUDE.md
git commit -m "docs: correct the MFA and sign-in copy, bump the ledger to 0136"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass. Test count should be 1045 + 26 = **1071**. Lint: 0 errors + the 2 known pre-existing warnings.

- [ ] **Step 2: Confirm no migration crept in**

Run: `git diff --stat origin/main -- supabase/`
Expected: no output. Prod stays at 0136 and no `db push` is needed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/google-staff-signin
```

- [ ] **Step 4: Hand back for the live test**

The three things a redirect trace could not verify — the Supabase redirect allowlist, the Google publishing status, and the client secret — are all settled by one real sign-in against the deployed preview. Ask the user to sign in with `jamilaian21@gmail.com` and report what happens.

Then, in the app, change Freya's sign-in email from `lab.drmed@gmail.com` to `freyadylimx@gmail.com` via **Staff users → edit → Sign-in email**, and have her sign in.

---

## Notes for the implementer

- **Do not create a migration.** This whole change is code-only.
- **`(dashboard)` is an invisible route group.** `src/app/(staff)/staff/(dashboard)/users` serves `/staff/users`. `/staff/mfa` and `/staff/login` sit outside it.
- **`/auth/callback` is deliberately NOT under `(staff)`** — it must not run any staff guard, because at that moment the caller has no session yet.
- **`audit()` logs and swallows.** That is the house pattern; do not change it here.
- **Paths with parentheses need quoting** in `git add` and `grep`.
- **`git push` needs `dangerouslyDisableSandbox: true`**, and the first push of a session sometimes times out and succeeds on retry.
