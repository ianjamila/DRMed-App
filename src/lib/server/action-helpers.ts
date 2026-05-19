import "server-only";
import { headers } from "next/headers";
import type { z } from "zod";

// Capture the request's IP + User-Agent for audit_log rows. The x-forwarded-for
// header carries the original client IP under Vercel's proxy chain (the first
// element is the real client). Returns nulls if either header is absent so
// the typed audit insert doesn't break.
export async function ipAndAgent(): Promise<{
  ip: string | null;
  ua: string | null;
}> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

// Surface the first message from a Zod validation error. Used by Server
// Actions that return `{ ok: false, error }` to the client — the client only
// ever shows the leading issue, so flattening the rest is fine.
export function firstIssue(
  err: z.ZodError,
  fallback = "Please check the form.",
): string {
  return err.issues[0]?.message ?? fallback;
}
