import { redirect } from "next/navigation";
import { clearPatientSessionCookie } from "@/lib/auth/patient-session-cookies";
import { getActivePatientSession, hasSignedPatientCookie } from "@/lib/auth/require-patient";

// 0167: requirePatientProfile() (a Server Component, via the authenticated
// layout) can detect a signed session cookie whose patient record has since
// been deleted or merged, but a Server Component render cannot clear a
// cookie — per node_modules/next/dist/docs/01-app/03-api-reference/
// 04-functions/cookies.md, ".set"/".delete" only work in a Server Function
// (Server Action) or a Route Handler; calling them during render is not
// supported. So requirePatientProfile redirects here instead of straight to
// /portal/login when a raw cookie was present but the active check failed.
//
// Hardened after Opus re-review of a3f42261: this used to clear the cookie
// UNCONDITIONALLY on any hit. That's wrong — Next's cookies().delete()
// issues its deletion Set-Cookie with no explicit SameSite attribute, so the
// browser applies it as SameSite=Lax rather than the original cookie's
// Strict, meaning a bare cross-site top-level link straight to this URL
// could reach the server and clear an ACTIVE patient's session. This
// handler re-derives both facts itself rather than trusting why the browser
// landed here:
//   - no signed cookie at all  -> nothing to clear;            /portal/login
//   - signed cookie, ACTIVE    -> leave the cookie alone;      /portal
//   - signed cookie, inactive  -> clear it, THEN                /portal/login
export async function GET() {
  const hasCookie = await hasSignedPatientCookie();
  if (!hasCookie) {
    redirect("/portal/login");
  }

  const active = await getActivePatientSession();
  if (active) {
    redirect("/portal");
  }

  await clearPatientSessionCookie();
  redirect("/portal/login");
}
