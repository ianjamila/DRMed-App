import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  PATIENT_SESSION_COOKIE_NAME,
  verifyPatientSession,
} from "@/lib/auth/patient-session";
import {
  ATTRIBUTION_COOKIE_NAME,
  ATTRIBUTION_MAX_AGE_SECONDS,
  attributionFromSearchParams,
} from "@/lib/analytics/attribution";
import { CONSENT_COOKIE_NAME, hasAdvertisingConsent } from "@/lib/analytics/consent";

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  // ---- Patient portal: verify HttpOnly JWT cookie ----------------------------
  if (pathname.startsWith("/portal") && !pathname.startsWith("/portal/login")) {
    const token = request.cookies.get(PATIENT_SESSION_COOKIE_NAME)?.value;
    if (!token || !(await verifyPatientSession(token))) {
      const url = request.nextUrl.clone();
      url.pathname = "/portal/login";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  // ---- Ad-click attribution: capture UTM params from the landing URL (last
  // touch, 30 days). Computed here (pure, no side effects) and applied to the
  // final `response` object at the end of this function — the Supabase
  // cookie-refresh logic below reassigns `response`, so setting the cookie any
  // earlier would get silently dropped.
  //
  // Gated three ways: never on /staff or /portal (RA 10173 — no marketing
  // tracking in those contexts; /portal must be re-checked here because the
  // authenticated-portal branch above deliberately excludes /portal/login,
  // which would otherwise fall through and get tagged), and never without the
  // visitor's explicit opt-in consent.
  const consented = hasAdvertisingConsent(
    request.cookies.get(CONSENT_COOKIE_NAME)?.value,
  );
  const attribution =
    consented && !pathname.startsWith("/staff") && !pathname.startsWith("/portal")
      ? attributionFromSearchParams(searchParams, pathname)
      : null;

  // ---- Staff portal: refresh Supabase session and guard ----------------------
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() refreshes the auth cookies on every request — keep this call.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (
    pathname.startsWith("/staff") &&
    !pathname.startsWith("/staff/login") &&
    !user
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/staff/login";
    return NextResponse.redirect(url);
  }

  if (attribution) {
    response.cookies.set(ATTRIBUTION_COOKIE_NAME, JSON.stringify(attribution), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
    });
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every path except Next.js internals, static asset extensions,
    // and the Sentry tunnel route (high-volume POSTs that would otherwise
    // pay the cost of a full Supabase session refresh).
    "/((?!_next/static|_next/image|favicon.ico|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
