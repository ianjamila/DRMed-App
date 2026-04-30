import "server-only";
import { cookies } from "next/headers";

// Flash mechanism: when reception creates a visit, the plain PIN is stashed in
// an HttpOnly cookie scoped to /staff and consumed exactly once on the receipt
// page. We never log it, never persist it server-side beyond the bcrypt hash.

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
    maxAge: 60 * 5, // 5 min — receipt page should be opened immediately
  });
}

export async function consumeVisitPinFlash(
  visitId: string,
): Promise<string | null> {
  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  c.delete(COOKIE_NAME);
  try {
    const parsed = JSON.parse(raw) as FlashPayload;
    if (parsed.visit_id !== visitId) return null;
    return parsed.pin;
  } catch {
    return null;
  }
}
