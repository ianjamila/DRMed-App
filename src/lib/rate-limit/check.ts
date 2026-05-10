import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type RateLimitBucket =
  | "patient_pin"
  | "public_booking"
  | "contact_form"
  | "newsletter_signup"
  | "patient_lookup"
  | "staff_login";

export interface RateLimitConfig {
  bucket: RateLimitBucket;
  identifier: string; // typically the IP, optionally suffixed
  windowSec: number;
  max: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

// Sliding-window check. Inserts the attempt, then counts how many fall in
// the configured window. If we're over the limit, returns the seconds
// until the oldest in-window attempt drops out — that's when the caller
// should be allowed to try again.
//
// On any DB error we fail-open with `allowed: true` and log the error;
// rate-limiting silently breaking is preferable to locking everyone out
// during a Supabase blip.
export async function checkRateLimit(
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  if (!cfg.identifier) return { allowed: true };

  const admin = createAdminClient();
  const since = new Date(Date.now() - cfg.windowSec * 1000).toISOString();

  const { error: insErr } = await admin
    .from("rate_limit_attempts")
    .insert({ bucket: cfg.bucket, identifier: cfg.identifier });
  if (insErr) {
    console.error("rate_limit insert failed", insErr);
    return { allowed: true };
  }

  const { data: rows, error: selErr } = await admin
    .from("rate_limit_attempts")
    .select("attempted_at")
    .eq("bucket", cfg.bucket)
    .eq("identifier", cfg.identifier)
    .gte("attempted_at", since)
    .order("attempted_at", { ascending: true });
  if (selErr) {
    console.error("rate_limit count failed", selErr);
    return { allowed: true };
  }

  if (!rows || rows.length <= cfg.max) return { allowed: true };

  const oldestMs = new Date(rows[0]!.attempted_at).getTime();
  const retryAfterSec = Math.max(
    1,
    Math.ceil((oldestMs + cfg.windowSec * 1000 - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSec };
}

// Hardcoded budgets keep the call sites tidy and the limits auditable
// in one place.
export const RATE_LIMITS: Record<
  RateLimitBucket,
  { windowSec: number; max: number }
> = {
  // Patient PIN guessing — visit_pins.failed_attempts already locks the
  // PIN itself; this is the per-IP guard so an attacker can't sweep
  // DRM-IDs from one source.
  patient_pin: { windowSec: 15 * 60, max: 10 },
  public_booking: { windowSec: 60 * 60, max: 8 },
  contact_form: { windowSec: 60 * 60, max: 5 },
  newsletter_signup: { windowSec: 60 * 60, max: 5 },
  // Existing-patient lookup on /schedule. Tighter than public_booking
  // because a successful response confirms the (DRM-ID, last_name)
  // pair — a brute-force enumeration risk we don't otherwise have.
  patient_lookup: { windowSec: 15 * 60, max: 8 },
  // Staff sign-in. Supabase Auth has its own per-IP throttle but doesn't
  // expose limits we control or audit. We layer our own: callers check
  // both per-IP (credential stuffing) and per-email (targeted brute
  // force) buckets before hitting signInWithPassword. 10/15min is loose
  // enough that legitimate typo-then-retry won't trigger it.
  staff_login: { windowSec: 15 * 60, max: 10 },
};
