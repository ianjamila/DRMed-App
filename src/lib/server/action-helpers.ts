import "server-only";
import { headers } from "next/headers";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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

// Returns true if the given audit signature was written by the same actor
// within the last N minutes. Used to dedupe high-frequency "viewed"-style
// events that fire on every Server Component render (force-dynamic +
// back-button navigation). Encapsulated here so the Date.now() call lives
// outside the React 19 render-purity scope.
export async function hasRecentAudit(
  admin: SupabaseClient<Database>,
  signature: { actor_id: string; action: string; resource_id: string },
  withinMinutes: number,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const { data } = await admin
    .from("audit_log")
    .select("id")
    .eq("actor_id", signature.actor_id)
    .eq("action", signature.action)
    .eq("resource_id", signature.resource_id)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle();
  return !!data;
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
