import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { changesPerAmendment, type AmendmentChanges, type SnapshotValue } from "./version-diff";

type Db = SupabaseClient<Database>;

type ReadOnceResult = { ok: true; changes: AmendmentChanges[] } | { ok: false; retry: boolean };

// R3: fetchVersionDiff reads result_amendments then result_values in two
// separate round trips. A correction can COMMIT between them (result_edit_commit
// inserts the new result_amendments row and bumps results.amendment_count in
// the same transaction) — the amendments list would then be one version
// behind result_values, pairing the last amendment's "prior" snapshot against
// a LATER version's current values and mislabelling which version is which.
// After both reads, re-read results.amendment_count (the single source of
// truth for "how many corrections has this result had") and compare it to
// the highest amendment_seq just read; a mismatch means the race happened
// mid-read, so the whole read is discarded and retried once by the caller.
async function readVersionDiffOnce(db: Db, resultId: string): Promise<ReadOnceResult> {
  const { data: amendments, error: amendErr } = await db
    .from("result_amendments")
    .select("id, amendment_seq, amended_at, prior_values_json")
    .eq("result_id", resultId)
    .order("amendment_seq", { ascending: true });
  if (amendErr) return { ok: false, retry: false };

  const { data: valueRows, error: valErr } = await db
    .from("result_values")
    .select(
      "parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank, result_template_params(parameter_name)",
    )
    .eq("result_id", resultId);
  if (valErr) return { ok: false, retry: false };

  const { data: resRow, error: resErr } = await db
    .from("results")
    .select("amendment_count")
    .eq("id", resultId)
    .maybeSingle();
  if (resErr) return { ok: false, retry: false };

  const maxSeqRead = (amendments ?? []).reduce((m, a) => Math.max(m, a.amendment_seq), 0);
  if ((resRow?.amendment_count ?? 0) !== maxSeqRead) return { ok: false, retry: true };

  const current: SnapshotValue[] = (valueRows ?? []).map((v) => {
    const param = Array.isArray(v.result_template_params)
      ? v.result_template_params[0]
      : v.result_template_params;
    return {
      parameter_id: v.parameter_id,
      parameter_name: param?.parameter_name ?? null,
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      text_value: v.text_value,
      select_value: v.select_value,
      flag: v.flag,
      is_blank: v.is_blank,
    };
  });

  return {
    ok: true,
    changes: changesPerAmendment(
      (amendments ?? []).map((a) => ({
        id: a.id,
        amendment_seq: a.amendment_seq,
        amended_at: a.amended_at,
        prior_values_json: a.prior_values_json as SnapshotValue[] | null,
      })),
      current,
    ),
  };
}

/**
 * "What changed" between versions of a corrected structured result. Staff
 * only — reads through the SIGNED-IN client so RLS applies:
 * result_amendments' read policy is staff_can_read_finished_result(result_id)
 * and result_values matches, so reception and out-of-section lab staff get
 * an empty read (not an error) and the caller simply renders nothing.
 *
 * Returns null on any read error, or when a concurrent correction (R3) still
 * looks unstable after one retry — the caller shows nothing rather than a
 * mislabelled diff. Callers should skip calling this at all for a result
 * with amendment_count = 0 — there is nothing to show and no need for the
 * query.
 *
 * No dedicated unit test: this repo's convention (CLAUDE.md) is that
 * `*.server.ts` files import "server-only" and are exercised through the
 * smoke scripts / manual QA, not vitest — there is no existing
 * `*.server.test.ts` anywhere to extend, and faking three chained
 * SupabaseClient reads well enough to prove the retry-then-null race would
 * mostly test the fake, not this function.
 */
export async function fetchVersionDiff(db: Db, resultId: string): Promise<AmendmentChanges[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readVersionDiffOnce(db, resultId);
    if (result.ok) return result.changes;
    if (!result.retry) return null;
  }
  return null;
}
