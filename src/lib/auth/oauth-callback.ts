import { safeRedirectPath } from "./safe-redirect";
import type { Json } from "@/types/database";

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
  // Written straight into the audit_log.metadata jsonb column, so every value
  // must be Json-shaped (not just `unknown`) or the real audit() dep — typed
  // against AuditEntry.metadata?: Json | null — won't typecheck against this.
  metadata: Record<string, Json | undefined>;
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
  /** Must resolve, never reject — implementations catch and report their own failures. */
  signOut: () => Promise<void>;
  /** Must resolve, never reject — implementations catch and report their own failures. */
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
      action: "staff.signin.rejected_inactive",
      metadata: {
        provider: "google",
        email: exchanged.email,
        has_profile: !!profile,
        is_deleted: !!profile?.deleted_at,
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
