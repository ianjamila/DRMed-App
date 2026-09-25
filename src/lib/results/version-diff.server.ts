import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { changesPerAmendment, type AmendmentChanges, type SnapshotValue } from "./version-diff";

type Db = SupabaseClient<Database>;

/**
 * "What changed" between versions of a corrected structured result. Staff
 * only — reads through the SIGNED-IN client so RLS applies:
 * result_amendments' read policy is staff_can_read_finished_result(result_id)
 * and result_values matches, so reception and out-of-section lab staff get
 * an empty read (not an error) and the caller simply renders nothing.
 *
 * Returns null on any read error (caller shows nothing rather than a wrong
 * diff). Callers should skip calling this at all for a result with
 * amendment_count = 0 — there is nothing to show and no need for the query.
 */
export async function fetchVersionDiff(db: Db, resultId: string): Promise<AmendmentChanges[] | null> {
  const { data: amendments, error: amendErr } = await db
    .from("result_amendments")
    .select("id, amendment_seq, amended_at, prior_values_json")
    .eq("result_id", resultId)
    .order("amendment_seq", { ascending: true });
  if (amendErr) return null;

  const { data: valueRows, error: valErr } = await db
    .from("result_values")
    .select(
      "parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank, result_template_params(parameter_name)",
    )
    .eq("result_id", resultId);
  if (valErr) return null;

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

  return changesPerAmendment(
    (amendments ?? []).map((a) => ({
      id: a.id,
      amendment_seq: a.amendment_seq,
      amended_at: a.amended_at,
      prior_values_json: a.prior_values_json as SnapshotValue[] | null,
    })),
    current,
  );
}
