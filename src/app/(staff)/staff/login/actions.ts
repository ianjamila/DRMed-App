"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function signInStaff(
  _prevState: SignInResult | null,
  formData: FormData,
): Promise<SignInResult> {
  const parsed = SignInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

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
    return { ok: false, error: "Invalid email or password." };
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
