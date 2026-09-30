/**
 * Why a combined (chemistry) report's whole-report scope is refused (0172).
 *
 * A combined report is ONE `results` row shared by several `test_requests`
 * through `result_test_requests`, so release and undo-release act on every
 * member together. Since 0198 the expansion and these refusals run inside
 * release_visit_results / undo_visit_release, under locks; this type is what
 * is left in TypeScript — the vocabulary REPORT_REFUSAL
 * (src/lib/queue/report-release-scope.ts) words for the release path.
 */
export type UndoScopeRejectionReason =
  | "outside_sections"
  | "package_header"
  | "other_visit";
