// Shared "is this shared result PDF safe to hand a patient?" check.
//
// One `results` row can be linked to several `test_requests` via the
// `result_test_requests` junction (a consolidated chemistry report links
// every test in the group to one shared PDF). If a lab undoes the release
// of ONE linked test, the other siblings can still show `status =
// 'released'` — but the stored PDF still contains the withdrawn test's
// values, so it must stop being downloadable through ANY path until every
// linked test is released again.
//
// A single-test result has exactly one junction row, so `allLinksReleased`
// reduces to a plain `status === 'released'` check there — see the "single
// link" test below and the reduction note at each call site.
//
// Used from every path that can hand out a result's `storage_path`:
//   - getPatientConsolidatedResultDownloadUrl (portal actions.ts)
//   - getPatientResultDownloadUrl (portal actions.ts)
//   - the patient data-export ZIP (data-export/route.ts)
//
// This module must stay free of "server-only" imports — only types are
// pulled in here; every caller passes in its own already-constructed
// Supabase client (never import the admin client at module scope from
// src/lib/results/).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Pure: given the current status of every test_request linked to one
// result, decide whether the shared PDF is safe to serve. Empty input (no
// links at all — should never happen for a real result, but fail closed
// rather than open) is treated as NOT eligible.
export function allLinksReleased(linkStatuses: string[]): boolean {
  return linkStatuses.length > 0 && linkStatuses.every((s) => s === "released");
}

// Fetches every test_request status currently linked to `resultId` via
// result_test_requests, using the caller's ADMIN client (bypasses RLS) —
// an RLS-scoped patient client can't be trusted here because the policy
// backing it is itself released-gated, so an un-released sibling would
// simply be missing from the result set instead of showing up as
// unreleased (see N6 in the portal actions). Callers own client
// construction; this module never imports the admin client itself.
export async function fetchLinkedTestRequestStatuses(
  admin: SupabaseClient<Database>,
  resultId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("result_test_requests")
    .select("test_requests!inner(status)")
    .eq("result_id", resultId);
  return (data ?? []).map((row) => {
    const tr = Array.isArray(row.test_requests)
      ? row.test_requests[0]
      : row.test_requests;
    return tr?.status ?? "";
  });
}

// Convenience combining both: true only when the shared PDF for `resultId`
// is safe to serve right now.
export async function isResultDownloadEligible(
  admin: SupabaseClient<Database>,
  resultId: string,
): Promise<boolean> {
  return allLinksReleased(await fetchLinkedTestRequestStatuses(admin, resultId));
}

export const WITHDRAWN_SHARED_RESULT_ERROR =
  "This shared report is temporarily unavailable — part of it was withdrawn after release. Please contact the lab for an updated copy.";
