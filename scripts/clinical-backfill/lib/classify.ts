import type { RawRow, RowClass } from "./types";

export interface Window { start: string; cutoverExclusive: string; }

/**
 * Classify a row for the backfill. `isConsult` switches the "has the clinic
 * any revenue?" test to clinic_fee (consults pass PF through to the doctor).
 */
export function classifyRow(
  r: RawRow, win: Window, isConsult: boolean, doctorKeepsFullFee = false,
): RowClass {
  if (!r.posting_date) return "bad_date";
  if (r.posting_date < win.start || r.posting_date >= win.cutoverExclusive) {
    return "out_of_window";
  }
  if (isConsult) {
    if (r.clinic_fee > 0) return "postable";
    return doctorKeepsFullFee ? "postable" : "zero_amount";   // rent/shareholder keep full fee → clinic_fee=0 is expected
  }
  return r.final > 0 || r.base > 0 ? "postable" : "zero_amount";
}
