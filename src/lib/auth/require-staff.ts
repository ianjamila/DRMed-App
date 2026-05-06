import "server-only";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";

export interface StaffSession {
  user_id: string;
  email: string;
  full_name: string;
  role:
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin"
    | "xray_technician";
}

// Call at the top of any protected /staff/* server component.
// Verifies (1) Supabase auth user exists, (2) an active staff_profile row exists.
// On failure: signs the user out and redirects to /staff/login.
export async function requireActiveStaff(): Promise<StaffSession> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/staff/login");
  }

  const { data: profile } = await supabase
    .from("staff_profiles")
    .select("full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) {
    const h = await headers();
    await audit({
      actor_id: user.id,
      actor_type: "staff",
      action: "staff.signin.rejected_inactive",
      metadata: { email: user.email ?? null, has_profile: !!profile },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
    await supabase.auth.signOut();
    redirect("/staff/login");
  }

  return {
    user_id: user.id,
    email: user.email ?? "",
    full_name: profile.full_name,
    role: profile.role as StaffSession["role"],
  };
}
