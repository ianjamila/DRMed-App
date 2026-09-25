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

// Shared select behind both readers below, so the "every linked member,
// deleted ones included" query can't drift between the lenient (portal) and
// error-aware (notify-corrected, X1) forms.
function selectLinkedTestRequestStatuses(
  admin: SupabaseClient<Database>,
  resultId: string,
) {
  return admin
    .from("result_test_requests")
    .select("test_requests!inner(status)")
    .eq("result_id", resultId);
}

function mapLinkedTestRequestStatuses(
  data: { test_requests: { status: string } | { status: string }[] }[] | null,
): string[] {
  return (data ?? []).map((row) => {
    const tr = Array.isArray(row.test_requests)
      ? row.test_requests[0]
      : row.test_requests;
    return tr?.status ?? "";
  });
}

// Fetches every test_request status currently linked to `resultId` via
// result_test_requests, using the caller's ADMIN client (bypasses RLS) —
// an RLS-scoped patient client can't be trusted here because the policy
// backing it is itself released-gated, so an un-released sibling would
// simply be missing from the result set instead of showing up as
// unreleased (see N6 in the portal actions). Callers own client
// construction; this module never imports the admin client itself.
//
// Swallows a read error (`data ?? []`) — used by the portal, which has no
// better fallback than "not eligible" for either case. Do NOT change this
// behaviour; a caller that must tell the two apart (X1) uses the strict
// sibling below instead.
export async function fetchLinkedTestRequestStatuses(
  admin: SupabaseClient<Database>,
  resultId: string,
): Promise<string[]> {
  const { data } = await selectLinkedTestRequestStatuses(admin, resultId);
  return mapLinkedTestRequestStatuses(data);
}

// X1: same query as fetchLinkedTestRequestStatuses (so the two can't drift),
// but error-aware — returns null on a read error instead of silently
// treating it as "no links" (which allLinksReleased would in turn treat as
// "not released" rather than "could not tell"). Used by notify-corrected so
// a transient read failure reports "failed" rather than a false
// "not_released".
export async function fetchLinkedTestRequestStatusesStrict(
  admin: SupabaseClient<Database>,
  resultId: string,
): Promise<string[] | null> {
  const { data, error } = await selectLinkedTestRequestStatuses(admin, resultId);
  if (error) return null;
  return mapLinkedTestRequestStatuses(data);
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
