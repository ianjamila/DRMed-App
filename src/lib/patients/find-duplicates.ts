// src/lib/patients/find-duplicates.ts
import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { scorePair, type CandidateFields, type DupScore, type DupTier } from "./duplicates";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface CandidatePatient extends CandidateFields {
  id: string;
  drm_id: string;
  middle_name: string | null;
  is_legacy: boolean;
  created_at: string;
}

export interface CandidatePair {
  id_a: string;
  id_b: string;
  a: CandidatePatient;
  b: CandidatePatient;
  score: DupScore;
}

export interface ScoredCandidate {
  patient: CandidatePatient;
  score: DupScore;
}

const TIER_RANK: Record<DupTier, number> = { weak: 1, probable: 2, strong: 3, exact_dup: 4 };
export function tierAtLeast(tier: DupTier | null, min: DupTier): boolean {
  return tier !== null && TIER_RANK[tier] >= TIER_RANK[min];
}

// Map one side (a_/b_) of a view row to a CandidatePatient.
function side(row: Record<string, unknown>, p: "a" | "b", idKey: "id_a" | "id_b"): CandidatePatient {
  const g = (k: string) => row[`${p}_${k}`] as never;
  return {
    id: row[idKey] as string,
    drm_id: g("drm_id"),
    first_name: g("first_name"),
    last_name: g("last_name"),
    middle_name: g("middle_name"),
    birthdate: g("birthdate"),
    email: g("email"),
    phone_normalized: g("phone_normalized"),
    address: g("address"),
    sex: g("sex"),
    is_legacy: g("is_legacy"),
    created_at: g("created_at"),
  };
}

export interface CandidatePairsResult {
  pairs: CandidatePair[];
  // The 20,000-row export ceiling was reached — `pairs` is not the full set.
  truncated: boolean;
  // The underlying read failed. Distinguish this from "genuinely zero
  // candidates" — a caller that only reads `pairs.length` can't tell a
  // crashed query from a clean dedup pass, and a dashboard used to render
  // both as a reassuring "0 duplicates".
  error: boolean;
}

// Shared implementation: pages past PostgREST's 1000-row cap (the view was a
// bare `.select("*")` with no `.range()`, so a clinic with enough patients to
// exceed it would have silently seen a short list with no signal that rows
// were missing) and reports the outcome instead of only logging it.
async function loadCandidatePairsResult(
  admin: AdminClient,
  opts: { minTier?: DupTier } = {},
): Promise<CandidatePairsResult> {
  const min = opts.minTier ?? "probable";
  try {
    // (id_a, id_b) is a unique key of the view (a plain `union`, not `union
    // all`, over three blocking-key joins with id_a < id_b) — ordering by
    // both gives `fetchAllRows` the total order it needs across pages.
    const { rows, truncated } = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        admin
          .from("v_patient_dedup_candidate_pairs")
          .select("*")
          .order("id_a", { ascending: true })
          .order("id_b", { ascending: true })
          .range(from, to),
      REPORT_EXPORT_MAX_ROWS,
    );
    const out: CandidatePair[] = [];
    for (const row of rows) {
      const a = side(row, "a", "id_a");
      const b = side(row, "b", "id_b");
      const score = scorePair(a, b);
      if (tierAtLeast(score.tier, min)) {
        out.push({ id_a: a.id, id_b: b.id, a, b, score });
      }
    }
    out.sort((x, y) => y.score.score - x.score.score);
    return { pairs: out, truncated, error: false };
  } catch (error) {
    // Surface to Sentry — otherwise the report/dashboard/digest silently show 0.
    await reportError({ scope: "loadCandidatePairs", error });
    return { pairs: [], truncated: false, error: true };
  }
}

// All candidate pairs for the admin report, scored and ranked. Kept
// backward-compatible (plain array, failure folds into "no candidates") for
// its existing callers (patient-merge/candidates, the dedup-digest cron) —
// callers that need to tell a failure apart from a clean pass should use
// loadCandidatePairsWithStatus instead.
export async function loadCandidatePairs(
  admin: AdminClient,
  opts: { minTier?: DupTier } = {},
): Promise<CandidatePair[]> {
  const { pairs } = await loadCandidatePairsResult(admin, opts);
  return pairs;
}

// Same data, plus enough to tell "0 candidates" apart from "the read failed"
// and "more matched than the export ceiling allows".
export async function loadCandidatePairsWithStatus(
  admin: AdminClient,
  opts: { minTier?: DupTier } = {},
): Promise<CandidatePairsResult> {
  return loadCandidatePairsResult(admin, opts);
}

// Candidates for one in-progress patient (staff near-match warning).
export async function findCandidatesForInput(
  admin: AdminClient,
  input: CandidateFields & { excludeId?: string },
  opts: { minTier?: DupTier } = {},
): Promise<ScoredCandidate[]> {
  const min = opts.minTier ?? "probable";
  const email = (input.email ?? "").trim().toLowerCase();
  const phone = input.phone_normalized;
  const last = input.last_name.trim();
  const birth = input.birthdate;

  const clauses: string[] = [];
  if (email) clauses.push(`email.eq.${email}`);
  if (phone && phone.length === 10) clauses.push(`phone_normalized.eq.${phone}`);
  if (last && birth) {
    // Double-quote the value so PostgREST-reserved chars (commas in PH suffixes
    // like "De la Cruz, Jr.") don't break the .or() filter; ilike keeps it
    // case-insensitive, matching the candidate view's lower(trim()) blocking.
    const quotedLast = `"${last.replace(/(["\\])/g, "\\$1")}"`;
    clauses.push(`and(last_name.ilike.${quotedLast},birthdate.eq.${birth})`);
  }
  if (clauses.length === 0) return [];

  const { data, error } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, email, phone_normalized, address, sex, legacy_import_run_id, created_at",
    )
    .is("merged_into_id", null)
    .or(clauses.join(","))
    .limit(50);
  if (error) {
    await reportError({ scope: "findCandidatesForInput", error });
    return [];
  }
  if (!data) return [];

  const out: ScoredCandidate[] = [];
  for (const r of data) {
    if (input.excludeId && r.id === input.excludeId) continue;
    const patient: CandidatePatient = {
      id: r.id, drm_id: r.drm_id, first_name: r.first_name, last_name: r.last_name,
      middle_name: r.middle_name, birthdate: r.birthdate, email: r.email,
      phone_normalized: r.phone_normalized, address: r.address, sex: r.sex,
      is_legacy: r.legacy_import_run_id !== null, created_at: r.created_at,
    };
    const score = scorePair(input, patient);
    if (tierAtLeast(score.tier, min)) out.push({ patient, score });
  }
  out.sort((x, y) => y.score.score - x.score.score);
  return out;
}
