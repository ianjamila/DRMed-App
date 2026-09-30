// One wording for "why can't this be released", whether the reason comes
// from the app (disabled button, skipped bulk row) or from the database
// trigger (translatePgError). Change a string here, not at a call site.
export const RELEASE_BLOCKED_UNPAID =
  "Visit must be paid, waived, or HMO-covered before results can be released.";
export const RELEASE_BLOCKED_CONSENT =
  "Patient data-privacy consent is not on file — capture consent before releasing.";
export const RELEASE_REFUSAL_PATIENT_INACTIVE =
  "This patient's record is no longer active — open the surviving record.";
