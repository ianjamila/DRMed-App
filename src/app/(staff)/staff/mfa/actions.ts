"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";

export type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: string };

export interface EnrollPayload {
  factorId: string;
  qrCode: string; // SVG data URL
  secret: string; // text fallback if user can't scan QR
}

const CODE_RE = /^\d{6}$/;

async function clientIp(): Promise<{ ip: string | null; ua: string | null }> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

// Begin TOTP enrollment. If the user already has a verified factor, sends
// them through to the dashboard (nothing to enroll). If they have an
// unverified factor lying around from an interrupted attempt, that factor
// is unenrolled and replaced — the QR code is only returned at enroll
// time, so we can't resume an old factor. Returns the QR + secret + new
// factor id for the client form.
export async function beginEnrollmentAction(): Promise<
  ActionResult<EnrollPayload>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
  if (listErr) return { ok: false, error: listErr.message };

  // factors.totp is typed as verified-only by Supabase; unverified TOTP
  // factors live in factors.all. Clear any in-progress unverified factor
  // so we don't accumulate dead enrollments on every retry.
  const unverified = (factors?.all ?? []).find(
    (f) => f.factor_type === "totp" && f.status === "unverified",
  );
  if (unverified) {
    await supabase.auth.mfa.unenroll({ factorId: unverified.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `drmed-${Date.now()}`,
  });

  if (error || !data) {
    return {
      ok: false,
      error:
        error?.message ??
        "Could not start MFA enrollment. Verify project settings allow TOTP.",
    };
  }

  return {
    ok: true,
    data: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    },
  };
}

const VerifySchema = z.object({
  factorId: z.string().uuid(),
  code: z.string().regex(CODE_RE, "Code must be 6 digits."),
});

// Verify the 6-digit code from the authenticator app for an in-progress
// enrollment. On success the factor flips to "verified" and the user's
// session upgrades to aal2. Audit-logs both outcomes.
export async function verifyEnrollmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = VerifySchema.safeParse({
    factorId: formData.get("factor_id"),
    code: formData.get("code"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad input." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { ip, ua } = await clientIp();

  const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({
    factorId: parsed.data.factorId,
  });
  if (chalErr || !chal) {
    return { ok: false, error: chalErr?.message ?? "Challenge failed." };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: parsed.data.factorId,
    challengeId: chal.id,
    code: parsed.data.code,
  });

  if (verifyErr) {
    await audit({
      actor_id: user.id,
      actor_type: "staff",
      action: "staff.mfa.enrollment_failed",
      metadata: { reason: verifyErr.message },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: false, error: "That code didn't match. Try again." };
  }

  await audit({
    actor_id: user.id,
    actor_type: "staff",
    action: "staff.mfa.enrolled",
    ip_address: ip,
    user_agent: ua,
  });

  redirect("/staff");
}

const ChallengeSchema = z.object({
  code: z.string().regex(CODE_RE, "Code must be 6 digits."),
});

// Submit a 6-digit code for an already-enrolled factor (post-sign-in).
// Picks the first verified factor — current product policy is one factor
// per user. On success the session reaches aal2.
export async function submitChallengeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = ChallengeSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad input." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { ip, ua } = await clientIp();

  const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
  if (listErr) return { ok: false, error: listErr.message };

  // factors.totp contains verified TOTP factors only.
  const verified = factors?.totp?.[0];
  if (!verified) {
    return { ok: false, error: "No verified MFA factor found." };
  }

  const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({
    factorId: verified.id,
  });
  if (chalErr || !chal) {
    return { ok: false, error: chalErr?.message ?? "Challenge failed." };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: verified.id,
    challengeId: chal.id,
    code: parsed.data.code,
  });

  if (verifyErr) {
    await audit({
      actor_id: user.id,
      actor_type: "staff",
      action: "staff.mfa.challenge_failed",
      metadata: { reason: verifyErr.message },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: false, error: "That code didn't match. Try again." };
  }

  await audit({
    actor_id: user.id,
    actor_type: "staff",
    action: "staff.mfa.challenge_succeeded",
    ip_address: ip,
    user_agent: ua,
  });

  redirect("/staff");
}
