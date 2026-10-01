import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { patientShortName } from "@/lib/notifications/release-staff-alert-content";
import { readInChunks } from "@/lib/supabase/in-chunks";
import { reportError } from "@/lib/observability/report-error";
import { manilaDate, manilaParts, manilaTime, todayManilaISODate, manilaISODate } from "@/lib/dates/manila";

// WHY test_requests.released_by and NOT audit_log: the release RPC (0198/0205)
// stamps released_by + released_at on the row itself, in the same statement as
// the status change, so a single read of the row answers "who and when" for
// every release (including pre-0205 ones, whose TS wrapper set released_by
// too). audit_log is admin-select-only under RLS, so reading it from the
// caller's staff client would silently return nothing for a medtech, and the
// only way round that is a service-role client this feature does not warrant.
// staff_profiles IS readable by every staff role ("staff read", 0023), so the
// caller's own client resolves the name too — no admin client anywhere.

/** "Maria Santos" → "Maria S." — first name + last initial, the owner's house format for staff alerts. */
export function staffShortName(fullName: string | null | undefined): string | null {
  const parts = (fullName ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return patientShortName(parts[0], parts.length > 1 ? parts[parts.length - 1] : null);
}

/** "at 2:14 PM" today (Manila), "on Sep 30 at 2:14 PM" on another day, "on Sep 30, 2025 at …" in another year. */
function whenClause(releasedAt: string | null): string {
  if (!releasedAt) return "";
  const time = manilaTime(releasedAt);
  if (time === "—") return "";
  const day = manilaISODate(releasedAt);
  if (day === todayManilaISODate()) return ` at ${time}`;
  const sameYear = manilaParts(releasedAt)?.year === manilaParts(new Date())?.year;
  const date = manilaDate(releasedAt);
  return ` on ${sameYear ? date.replace(/,\s*\d{4}$/, "") : date} at ${time}`;
}

/**
 * For test lines a Release click lost a race on, WHO released each one and
 * WHEN: "Already released by Maria S. at 2:14 PM." (another staff member),
 * "You already released this at 2:14 PM." (the caller — a double-click or a
 * second tab), "Already released at 2:14 PM." (no recorded releaser). A date
 * is added when the release was not today in Manila time.
 *
 * The map holds ONLY ids that are released right now — an id that is missing
 * (not released, deleted, or the lookup failed) is the caller's cue to keep
 * its generic reason. Best-effort and read-only: never throws, never turns a
 * refusal into anything worse than the generic wording.
 */
export async function describeRacedRelease(
  supabase: SupabaseClient,
  ids: readonly string[],
  callerId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return out;
  try {
    // readInChunks fails closed: one errored slice drops the whole lookup to the generic reason.
    const read = await readInChunks<{ id: string; released_at: string | null; released_by: string | null }>(unique, (chunk) =>
      supabase.from("test_requests").select("id, status, released_at, released_by, visits!inner ( deleted_at )")
        .in("id", chunk)
        .eq("status", "released")
        .is("deleted_at", null)
        .is("visits.deleted_at", null),
    );
    if (!read.ok) throw read.error;
    const released = read.rows;
    const others = Array.from(new Set(released.map((r) => r.released_by).filter((u): u is string => !!u && u !== callerId)));
    const names = new Map<string, string>();
    if (others.length > 0) {
      // A failed name read only costs the name: the "when" is still worth saying.
      const { data, error } = await supabase.from("staff_profiles").select("id, full_name").in("id", others);
      if (error) await reportError({ scope: "release/raced-name-lookup", error, metadata: { ids: unique } });
      for (const p of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
        const short = staffShortName(p.full_name);
        if (short) names.set(p.id, short);
      }
    }
    for (const r of released) {
      const when = whenClause(r.released_at);
      if (r.released_by === callerId) out.set(r.id, `You already released this${when}.`);
      else {
        const who = r.released_by ? names.get(r.released_by) : undefined;
        out.set(r.id, who ? `Already released by ${who}${when}.` : `Already released${when}.`);
      }
    }
  } catch (error) {
    out.clear();
    try {
      await reportError({ scope: "release/raced-lookup", error, metadata: { ids: unique } });
    } catch {
      // Reporting itself failed — the generic reason stands.
    }
  }
  return out;
}
