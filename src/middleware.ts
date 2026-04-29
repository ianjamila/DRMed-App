import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  PATIENT_SESSION_COOKIE_NAME,
  verifyPatientSession,
} from "@/lib/auth/patient-session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  return response;
}

export const config = {
  matcher: [
    // Run on every path except Next.js internals and static asset extensions.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
