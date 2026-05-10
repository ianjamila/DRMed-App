"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SignInResult = { ok: true } | { ok: false; error: string };

const GENERIC_AUTH_ERROR = "Invalid email or password.";

export async function signInStaff(
  _prevState: SignInResult | null,
  formData: FormData,
): Promise<SignInResult> {
  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  const parsed = SignInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Email and password are required." };
  }

  // Per-IP and per-email throttle. Supabase Auth has its own limits but
  // we want our own auditable layer. Per-email catches a slow-and-low
  // attack against one account from rotating IPs; per-IP catches
  // credential stuffing against many emails from one source.
  const emailKey = parsed.data.email.toLowerCase();
  const buckets: Array<{ identifier: string; kind: "ip" | "email" }> = [];
  if (ipAddress) buckets.push({ identifier: `ip:${ipAddress}`, kind: "ip" });
  buckets.push({ identifier: `email:${emailKey}`, kind: "email" });

  for (const b of buckets) {
    const limit = await checkRateLimit({
      bucket: "staff_login",
      identifier: b.identifier,
      ...RATE_LIMITS.staff_login,
    });
    if (!limit.allowed) {
      await audit({
        actor_id: null,
        actor_type: "anonymous",
        action: "staff.signin.rate_limited",
        metadata: {
          email: parsed.data.email,
          scope: b.kind,
          retry_after_sec: limit.retryAfterSec,
        },
        ip_address: ipAddress,
        user_agent: userAgent,
      });
      return {
        ok: false,
        error: `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.`,
      };
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error || !data.user) {
    await audit({
      actor_id: null,
      actor_type: "anonymous",
      action: "staff.signin.failed",
      metadata: {
        email: parsed.data.email,
        reason: error?.message ?? "unknown",
      },
      ip_address: ipAddress,
      user_agent: userAgent,
    });
    return { ok: false, error: GENERIC_AUTH_ERROR };
  }

  await audit({
    actor_id: data.user.id,
    actor_type: "staff",
    action: "staff.signin.success",
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  redirect("/staff");
}

export async function signOutStaff() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  await supabase.auth.signOut();

  if (user) {
    const h = await headers();
    await audit({
      actor_id: user.id,
      actor_type: "staff",
      action: "staff.signout",
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  redirect("/staff/login");
}
