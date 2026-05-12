import "server-only";

interface PgError {
  code?: string;
  message?: string;
  details?: string;
}

// Translate Postgres error codes + custom RAISE EXCEPTION codes into user
// readable strings. The original error is logged to Sentry by the Server
// Action layer; this function only produces the UI-facing message.
export function translatePgError(err: PgError): string {
  switch (err.code) {
    case "23505":
      // unique_violation — most likely a duplicate CoA code.
      return "That value already exists. Pick a different one.";
    case "23514":
      // check_violation — most likely the normal_balance / type mismatch.
      return "Invalid value: that combination is not allowed by the schema.";
    case "P0001":
      // Our je_lines_balance_check raise. The message already names the JE.
      return err.message ?? "Journal entry is unbalanced.";
    case "P0002":
      // Our je_period_lock_check raise.
      return err.message ?? "That accounting period is closed.";
    case "P0003":
      // Zero-line guard: journal entry has no lines.
      return err.message ?? "Journal entry must have at least one line.";
    default:
      return err.message ?? "Database error. Please try again.";
  }
}
