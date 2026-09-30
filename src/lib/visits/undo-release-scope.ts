/**
 * Whole-report undo-release scope expansion (0172, PR 2 §5 / §9 R4, R6).
 *
 * A combined (chemistry) report is ONE `results` row shared by several
 * `test_requests` through `result_test_requests`. Undoing the release of a
 * single member alone would leave the shared PDF claiming a test whose
 * release the clinic just reversed, while the report itself still says
 * "released" — so undo-release on any member of a combined report expands to
 * every member of that report, REGARDLESS of the member's own status (a
 * partially released combined report, legacy or mid-flight, is undone as a
 * whole).
 *
 * The expansion is rejected — the WHOLE request, not just the offending
 * member — when any member of a touched report:
 *   - sits outside the caller's allowed sections (`sectionsForRole`, where
 *     `[]` means deny, same rule as `scopeToAllowedSections`);
 *   - is a package header (data anomaly guard — a header should never carry
 *     a direct result link, but the check costs nothing);
 *   - sits on a different visit than the one the caller is acting on.
 *
 * This mirrors `staff_can_read_finished_result`'s membership rule (0172,
 * PR 2 §9 R3): the check runs over EVERY linked member, deleted ones
 * included, because a deleted member still holds values on the shared
 * result and still belongs to the report's true membership. The final
 * status-filtered UPDATE (in the caller) is what actually decides which
 * members revert — deleted members, and members not currently `released`,
 * are excluded there, exactly as before this expansion existed.
 *
 * Pure — no Supabase, no `server-only` import. The caller does the fetching
 * (one junction query keyed by the caller's original selection, one more
 * keyed by the result ids it touches — no N+1) and passes plain rows in.
 *
 * Also home to two more pure decisions for `undoReleaseBatchAction`'s
 * Finding-4 fix (P1, 2026-09-30): `reportsToRefuse` decides which combined
 * reports a batch Undo must refuse WHOLE (a member changed-since, or never
 * released by this exact batch), and `groupIdsByExpectedReleasedAt` groups a
 * write's ids by the exact release identity each one's audit row recorded, so
 * the batch Undo's UPDATE can be predicated on the SAME release it read
 * back — not merely "still released" — without touching the manual
 * (`undoReleaseSelectedAction`) or sample-visit-delete paths, which never
 * supply that identity and keep today's plain status-filtered write.
 */

import { sameInstant } from "@/lib/ui/bulk-undo";

/** One `result_test_requests` row, joined out to what validation needs. */
export interface UndoScopeMemberRow {
  testRequestId: string;
  resultId: string;
  visitId: string;
  isPackageHeader: boolean;
  /** The member's service section, or null (e.g. a doctor line). */
  section: string | null;
}

export type UndoScopeRejectionReason =
  | "outside_sections"
  | "package_header"
  | "other_visit";

export interface UndoReleaseScopeExpansion {
  ok: true;
  /** The original selection, unioned with every member of any report it touched. */
  expandedIds: string[];
  /** testRequestId -> resultId, for ids that belong to an EXPANDED (multi-member) report. */
  reportResultIdByTestRequestId: ReadonlyMap<string, string>;
}

export interface UndoReleaseScopeRejection {
  ok: false;
  reason: UndoScopeRejectionReason;
  resultId: string;
}

export type UndoReleaseScopeResult =
  | UndoReleaseScopeExpansion
  | UndoReleaseScopeRejection;

function sectionAllowed(
  section: string | null,
  allowedSections: readonly string[] | null,
): boolean {
  if (allowedSections === null) return true; // admin/pathologist — unrestricted
  return section != null && allowedSections.includes(section);
}

/**
 * Expand `selectedIds` to the full membership of every combined report
 * (>1 linked test) it touches, or reject the whole request.
 *
 * `members` must be every `result_test_requests` row for every result id any
 * of `selectedIds` links to — the caller fetches this in two queries (ids ->
 * touched result ids, then result ids -> every member row); a group this
 * function only sees a PART of would undercount membership, so it trusts the
 * caller to have supplied the whole group for any result it includes at all.
 */
export function expandUndoReleaseScope(input: {
  selectedIds: readonly string[];
  members: readonly UndoScopeMemberRow[];
  visitId: string;
  allowedSections: readonly string[] | null;
}): UndoReleaseScopeResult {
  const { selectedIds, members, visitId, allowedSections } = input;

  const byResult = new Map<string, UndoScopeMemberRow[]>();
  for (const m of members) {
    const group = byResult.get(m.resultId) ?? [];
    group.push(m);
    byResult.set(m.resultId, group);
  }

  const selectedSet = new Set(selectedIds);
  const expanded = new Set<string>(selectedIds);
  const reportResultIdByTestRequestId = new Map<string, string>();

  for (const [resultId, group] of byResult) {
    if (group.length <= 1) continue; // not a combined report — no expansion
    if (!group.some((m) => selectedSet.has(m.testRequestId))) continue;

    for (const m of group) {
      if (!sectionAllowed(m.section, allowedSections)) {
        return { ok: false, reason: "outside_sections", resultId };
      }
      if (m.isPackageHeader) {
        return { ok: false, reason: "package_header", resultId };
      }
      if (m.visitId !== visitId) {
        return { ok: false, reason: "other_visit", resultId };
      }
    }

    for (const m of group) {
      expanded.add(m.testRequestId);
      reportResultIdByTestRequestId.set(m.testRequestId, resultId);
    }
  }

  return {
    ok: true,
    expandedIds: Array.from(expanded),
    reportResultIdByTestRequestId,
  };
}

/**
 * Whole-report undo [R4], the race half: the ids the final UPDATE targets.
 *
 * The action reads the released candidates one round trip BEFORE its UPDATE.
 * A member of an expanded report released in that window was not a candidate,
 * so targeting only the candidates would undo the rest of its report and leave
 * it released — one report, two statuses. So the UPDATE targets the candidates
 * PLUS every member of every expanded report, whatever it looked like when
 * read; the UPDATE's own `status = 'released'` filter decides which rows
 * actually revert. `expandUndoReleaseScope` has already proved every such
 * member is in the caller's sections, on this visit, and not a package header.
 */
export function undoUpdateIds(
  scopedCandidateIds: readonly string[],
  reportMemberIds: Iterable<string>,
): string[] {
  return Array.from(new Set([...scopedCandidateIds, ...reportMemberIds]));
}

export interface ReportRefusalInput {
  /**
   * testRequestId -> resultId, for every id belonging to an EXPANDED
   * (multi-member) report — the same shape `expandUndoReleaseScope` returns,
   * computed over the touched reports' WHOLE membership (not just the
   * candidates), so a report's rejected-as-changed or never-released member
   * is visible here even though it isn't itself a restore candidate.
   */
  reportResultIdByTestRequestId: ReadonlyMap<string, string>;
  /** Every id THIS batch released (has its own release audit row in it), regardless of changedSince. */
  batchReleasedIds: ReadonlySet<string>;
  /** Ids `loadOwnBatchRows` flagged as changed again since, by someone/something else. */
  changedSinceIds: ReadonlySet<string>;
}

/**
 * Which combined reports a batch Undo must refuse WHOLE (Finding 4, P1,
 * 2026-09-30): owner rule is "combined reports are all-or-nothing", but the
 * shared undo-release core expands ANY selected member to the full report
 * regardless of the OTHER members' provenance. Left unchecked, that lets:
 *   (a) a member already rejected as changed-since come back in through a
 *       sibling member's expansion, silently dropping its warning;
 *   (b) a member this batch never released at all (a different, possibly
 *       much older release) get reverted just because it shares a report
 *       with something this batch did release.
 * So: for every touched report, if ANY member is changed-since or was not
 * released by this exact batch, every member of that report is returned here
 * — the caller must route all of them to `notRestored` and none to the core.
 * A standalone id (absent from `reportResultIdByTestRequestId`) is never
 * returned — it keeps the plain per-row rule.
 */
export function reportsToRefuse(input: ReportRefusalInput): Set<string> {
  const { reportResultIdByTestRequestId, batchReleasedIds, changedSinceIds } = input;

  const membersByResult = new Map<string, string[]>();
  for (const [testRequestId, resultId] of reportResultIdByTestRequestId) {
    const group = membersByResult.get(resultId) ?? [];
    group.push(testRequestId);
    membersByResult.set(resultId, group);
  }

  const refused = new Set<string>();
  for (const group of membersByResult.values()) {
    const unsafe = group.some(
      (id) => changedSinceIds.has(id) || !batchReleasedIds.has(id),
    );
    if (!unsafe) continue;
    for (const id of group) refused.add(id);
  }
  return refused;
}

/**
 * Group ids by the EXACT release identity `expectedReleasedAtOf` recorded for
 * each (Finding 4, P1) — one UPDATE per distinct instant, so a batch Undo's
 * write can be predicated on `released_at = <that exact value>` and can only
 * ever reverse the release it read back, never a same-status re-release that
 * happened inside the Undo window. Grouped by INSTANT (`sameInstant`), not by
 * raw string, since a value read back from PostgREST normalizes a `"Z"`
 * suffix to `"+00:00"` while the audit metadata this is built from keeps the
 * `"Z"` form `Date.toISOString()` writes — two spellings of the same release
 * must land in the same group, not two single-id groups. Ids with no recorded
 * value are refused — put in `refusedIds`, excluded from every group — since
 * an Undo with nothing to predicate on is not an Undo of a specific release.
 */
export function groupIdsByExpectedReleasedAt(
  ids: readonly string[],
  expectedReleasedAtOf: ReadonlyMap<string, string>,
): { groups: Array<{ releasedAt: string; ids: string[] }>; refusedIds: string[] } {
  const groups: Array<{ releasedAt: string; ids: string[] }> = [];
  const refusedIds: string[] = [];

  for (const id of ids) {
    const value = expectedReleasedAtOf.get(id);
    if (value === undefined) {
      refusedIds.push(id);
      continue;
    }
    const existing = groups.find((g) => sameInstant(g.releasedAt, value));
    if (existing) {
      existing.ids.push(id);
    } else {
      groups.push({ releasedAt: value, ids: [id] });
    }
  }

  return { groups, refusedIds };
}
