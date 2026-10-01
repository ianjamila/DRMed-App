// One wording for "why can't this be released", whether the reason comes
// from the app (disabled button, skipped bulk row) or from the database
// trigger (translatePgError). Change a string here, not at a call site.
export const RELEASE_BLOCKED_UNPAID =
  "Visit must be paid, waived, or HMO-covered before results can be released.";
export const RELEASE_BLOCKED_CONSENT =
  "Patient data-privacy consent is not on file — capture consent before releasing.";
export const RELEASE_REFUSAL_PATIENT_INACTIVE =
  "This patient's record is no longer active — open the surviving record.";

/** Release Undo does not un-notify: shown only when a notice actually went out (notifiedCount > 0). */
export const ALREADY_NOTIFIED =
  "The patient was already notified that results are ready — tell them if needed.";
/** The outbox could not finish the notice on the first try (0210): nothing has gone out yet. */
export const NOTICE_RETRYING =
  "The patient's \"result ready\" message has not gone out yet — it will retry automatically.";

/**
 * The Queue bar's message after a release Undo (undoReleaseBatchAction):
 * how many tests went back to Ready for release, the "already notified"
 * warning when the release's notice went out, and every test not undone by
 * name — the bar has cleared its selection, so this is the only record.
 */
export function releaseUndoMessage(r: {
  restored: number;
  notRestored: ReadonlyArray<{ label: string; reason: string }>;
  notified: boolean;
}): string {
  const head =
    r.restored === 0
      ? "Nothing was undone."
      : `Undone — ${r.restored} test${r.restored === 1 ? " is" : "s are"} back to Ready for release.${r.notified ? ` ${ALREADY_NOTIFIED}` : ""}`;
  if (r.notRestored.length === 0) return head;
  return [head, `Not undone (${r.notRestored.length}):`, ...r.notRestored.map((l) => `• ${l.label}: ${l.reason}`)].join("\n");
}
