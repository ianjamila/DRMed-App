// Mirrors migration 0155's CHECK constraint on staff_alert_recipients.email
// exactly:
//   char_length(email) between 6 and 254
//   and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
// so the "Extra addresses" add-form (client AND server) rejects the same
// values the database would — never a friendlier client check that lets a
// value through only for the DB to bounce it with a raw constraint error.
const ALERT_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const ALERT_EMAIL_MIN = 6;
export const ALERT_EMAIL_MAX = 254;

export function isValidAlertEmail(email: string): boolean {
  const trimmed = email.trim();
  return (
    trimmed.length >= ALERT_EMAIL_MIN &&
    trimmed.length <= ALERT_EMAIL_MAX &&
    ALERT_EMAIL_RE.test(trimmed)
  );
}
