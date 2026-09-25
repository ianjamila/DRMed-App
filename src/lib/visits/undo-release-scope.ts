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
 */

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
