import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isOutdatedCopiesCapped, type CopyState } from "./copy-followups";

type Db = SupabaseClient<Database>;

/** result_copy_state for staff pages (signed-in client — the RPC gates rows). null = read failed. */
export async function fetchCopyStates(db: Db, resultIds: readonly string[]): Promise<Map<string, CopyState> | null> {
  const ids = [...new Set(resultIds)];
  const out = new Map<string, CopyState>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.rpc("result_copy_state", { p_result_ids: ids.slice(i, i + 200) });
    if (error) return null;
    for (const row of data ?? []) out.set(row.result_id, row as CopyState);
  }
  return out;
}

/** Server-side re-check before sending a notice (service role, internal function). */
export async function fetchCopyStateAdmin(resultId: string): Promise<CopyState | undefined> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient().rpc("result_copy_states_internal", { p_result_ids: [resultId] });
  if (error || !data?.[0]) return undefined;
  const r = data[0];
  return {
    result_id: r.result_id, latest_amendment_id: r.latest_amendment_id,
    amendment_count: r.amendment_count, amended_at: r.amended_at,
    holds_copy: r.holds_copy, portal_outdated: r.portal_outdated,
    printed_outdated: r.printed_outdated, followed_up: r.followed_up,
    notified_at: r.notified_at, notify_failed: r.notify_error != null,
    has_email: r.has_email, has_phone: r.has_phone,
  };
}

export type OutdatedCopyRow = Database["public"]["Functions"]["result_outdated_copies"]["Returns"][number];

/** The follow-up list (signed-in client; reception/admin, else the RPC raises 42501).
 * `capped` is true when the row count hit PostgREST's max_rows (1000,
 * supabase/config.toml) — the RPC's rows may be a truncated view of the
 * real list, not the whole thing. */
export async function fetchOutdatedCopies(db: Db, includeFollowedUp: boolean) {
  const { data, error } = await db.rpc("result_outdated_copies", { p_include_followed_up: includeFollowedUp });
  if (error) return { ok: false as const, error };
  const rows = (data ?? []) as OutdatedCopyRow[];
  return { ok: true as const, rows, capped: isOutdatedCopiesCapped(rows.length) };
}
