import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";
import { handleOAuthCallback } from "@/lib/auth/oauth-callback";

// Supabase redirects here after Google. Must be a Route Handler:
// exchangeCodeForSession writes session cookies, which a Server Component
// cannot do.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const supabase = await createClient();
  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const outcome = await handleOAuthCallback(
    {
      code: searchParams.get("code"),
      next: searchParams.get("next"),
      ip,
      userAgent: ua,
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
      // The allow/reject decision is already made and audited by the time
      // these run — they're best-effort cleanup on the rejected path. A
      // throw here must never turn the intended fail-closed redirect into
      // Next's generic error page, and a returned error must never be
      // dropped silently (an orphaned auth.users row with zero trace), so
      // both report through reportError instead of propagating.
      signOut: async () => {
        try {
          const { error } = await supabase.auth.signOut();
          if (error) {
            await reportError({ scope: "auth.callback.signOut", error });
          }
        } catch (error) {
          await reportError({ scope: "auth.callback.signOut", error });
        }
      },
      deleteAuthUser: async (userId) => {
        try {
          const { error } = await admin.auth.admin.deleteUser(userId);
          if (error) {
            await reportError({
              scope: "auth.callback.deleteAuthUser",
              error,
              metadata: { userId },
            });
          }
        } catch (error) {
          await reportError({
            scope: "auth.callback.deleteAuthUser",
            error,
            metadata: { userId },
          });
        }
      },
      audit,
    },
  );

  return NextResponse.redirect(`${origin}${outcome.redirectTo}`);
}
