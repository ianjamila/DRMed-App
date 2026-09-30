// Patient-facing wording for a database error on the PUBLIC forms (/schedule,
// /register). translatePgError (src/lib/accounting/pg-errors.ts) is written for
// staff: it passes hand-written 23514/P00NN messages through verbatim, and those
// name internal records and rules ("a result can only hold one patient's
// tests", "patient DRM-0001 is deleted"). A public caller must never show that
// text — this translator never passes the Postgres message through.
// pg-errors-staff-only.test.ts fails if a non-staff page can import pg-errors.ts.

export interface DbErrorLike {
  code?: string;
  message?: string;
  details?: string;
}

// A database error translator: staff callers pass translatePgError, public
// callers pass publicDbError.
export type DbErrorTranslator = (err: DbErrorLike) => string;

export const PUBLIC_SAVE_ERROR =
  "We couldn't save your details. Please try again, or contact the clinic if this keeps happening.";
export const PUBLIC_SLOT_TAKEN_ERROR = "That slot was just taken. Please pick another time.";

export function publicDbError(err: DbErrorLike): string {
  // P0040: the slot filled up between the availability check and the insert.
  if (err.code === "P0040") return PUBLIC_SLOT_TAKEN_ERROR;
  return PUBLIC_SAVE_ERROR;
}
