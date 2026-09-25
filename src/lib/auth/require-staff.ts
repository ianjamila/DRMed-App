import "server-only";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { needsMfaChallenge } from "@/lib/auth/mfa-gate";
import { activeViewAs, type ActiveViewAs } from "@/lib/auth/view-as";

export interface StaffSession {
  user_id: string;
  email: string;
  full_name: string;
  /** The role every page should behave as — the admin's View-as override
   *  while one is active, otherwise the real role. */
  role:
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin"
    | "xray_technician";
  /** The real profile role. Only the View-as controls read this. */
  actual_role: StaffSession["role"];
  /** The active View-as override (admin only), or null. */
  view_as: ActiveViewAs | null;
}

// Verifies (1) Supabase auth user exists, (2) an active staff_profile row
// exists. Does NOT enforce MFA. Use this from the /staff/mfa page itself
// (else the MFA gate would redirect a user back to /staff/mfa forever)
// and nowhere else — every other protected staff page should use
// requireActiveStaff so the MFA gate fires.
export async function requireSignedInStaff(): Promise<StaffSession> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/staff/login");
  }

  const { data: profile } = await supabase
    .from("staff_profiles")
    .select("full_name, role, is_active, deleted_at, view_as_role, view_as_until")
    .eq("id", user.id)
    .maybeSingle();

  // Deleted users are treated identically to "no profile": the row stays
  // for audit-log resolution but the session is refused. Inactive users
  // are also blocked here so a soft-disabled account can't sign in.
  if (!profile || !profile.is_active || profile.deleted_at !== null) {
    const h = await headers();
    await audit({
      actor_id: user.id,
      actor_type: "staff",
      action: "staff.signin.rejected_inactive",
      metadata: {
        email: user.email ?? null,
        has_profile: !!profile,
        is_deleted: !!profile?.deleted_at,
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
    await supabase.auth.signOut();
    redirect("/staff/login");
  }

  // Admin "View as role": the columns are inert unless role = 'admin' and the
  // expiry is in the future — activeViewAs() is the TS mirror of the SQL CASE
  // in 0182 that RLS uses, so both layers agree on every request.
  const view_as = activeViewAs(profile);
  return {
    user_id: user.id,
    email: user.email ?? "",
    full_name: profile.full_name,
    role: (view_as?.role ?? profile.role) as StaffSession["role"],
    actual_role: profile.role as StaffSession["role"],
    view_as,
  };
}

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
