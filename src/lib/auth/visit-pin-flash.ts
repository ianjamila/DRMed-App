import "server-only";
import { cookies } from "next/headers";

// Flash mechanism: when reception creates a visit, the plain PIN is stashed in
// an HttpOnly cookie scoped to /staff. The receipt page peeks the value during
// SSR (read-only — Server Components can't mutate cookies), then a tiny client
// effect fires `clearVisitPinFlash` to delete it. Worst case, a reload within
// the few seconds before the effect runs will re-show the PIN; the cookie's
// 5-minute TTL caps the window.

const COOKIE_NAME = "drmed_visit_pin_flash";

interface FlashPayload {
  visit_id: string;
  pin: string;
}

export async function setVisitPinFlash(payload: FlashPayload): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_NAME, JSON.stringify(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/staff",
    maxAge: 60 * 5,
  });
}

// Read-only — safe in Server Components.
export async function peekVisitPinFlash(
  visitId: string,
): Promise<string | null> {
  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FlashPayload;
    if (parsed.visit_id !== visitId) return null;
    return parsed.pin;
  } catch {
    return null;
  }
}

// Mutating — must be called from a Server Action (e.g. via a client effect).
export async function clearVisitPinFlash(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}
