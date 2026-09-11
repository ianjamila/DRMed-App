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
