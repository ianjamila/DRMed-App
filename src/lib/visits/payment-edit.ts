// Edit payment (migration 0161, `correct_payment`). The SQL function is the
// source of truth; this module mirrors its rules so the visit page can hide
// the Edit button on a payment the database would refuse, and so the edit
// dialog can say what will happen before anyone presses Save.
// `payment-edit.test.ts` pins the method list against the migration text.

import { classifyKind } from "./classification";
import { moneySettled } from "./money-settled";

/** The counter methods an edited payment may use — the Record payment form's list minus Gift code. */
export const EDITABLE_PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash" },
  { value: "maya", label: "Maya" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
] as const;

export type EditablePaymentMethod = (typeof EDITABLE_PAYMENT_METHODS)[number]["value"];

export function isEditablePaymentMethod(m: string | null | undefined): m is EditablePaymentMethod {
  return EDITABLE_PAYMENT_METHODS.some((x) => x.value === m);
}

export interface EditablePaymentRow {
  method: string | null;
  voided_at: string | null;
  legacy_import_run_id: string | null;
}

export type PaymentEditability =
  | { editable: true }
  | { editable: false; reason: string };

/**
 * Whether Edit is offered for a payment. Mirrors correct_payment's refusals:
 * voided rows, gift-code redemptions and HMO settlements, and rows from the
 * legacy history import. Every one of them can still be deleted (voided).
 * Move (a correction onto another visit) refuses exactly the same rows.
 */
export function paymentEditability(
  p: EditablePaymentRow,
  verb: "edited" | "moved" = "edited",
): PaymentEditability {
  if (p.voided_at) {
    return { editable: false, reason: "This payment was already deleted or edited." };
  }
  if (p.method === "gift_code" || p.method === "hmo") {
    return {
      editable: false,
      reason: `Gift code and HMO payments cannot be ${verb}. Delete it and record it again.`,
    };
  }
  if (p.legacy_import_run_id) {
    return {
      editable: false,
      reason: `Payments from the imported history cannot be ${verb}. Delete it and record it again.`,
    };
  }
  return { editable: true };
}

/**
 * True when the edit changes the money (amount or method). A money change
 * voids the original and records a corrected payment; a reference/notes-only
 * edit updates the payment in place and leaves the books alone.
 */
export function isMoneyChange(
  before: { amount_php: number; method: string | null },
  after: { amount_php: number; method: string },
): boolean {
  return toCentavos(before.amount_php) !== toCentavos(after.amount_php) || before.method !== after.method;
}

/**
 * The visit balance after the edit, in pesos (negative = overpaid). Centavo
 * arithmetic so ₱0.25 steps do not drift.
 */
export function balanceAfterEdit(input: {
  visitTotal: number;
  visitPaid: number;
  oldAmount: number;
  newAmount: number;
}): number {
  const c =
    toCentavos(input.visitTotal) -
    toCentavos(input.visitPaid) +
    toCentavos(input.oldAmount) -
    toCentavos(input.newAmount);
  return c / 100;
}

function toCentavos(php: number): number {
  return Math.round(php * 100);
}

/** payments.amount_php is numeric(10,2); correct_payment (0174) refuses more. */
export const MAX_PAYMENT_PHP = 99_999_999.99;

/**
 * The payment as the caller saw it — sent to correct_payment as p_expected
 * (0174). Under the row lock the function refuses the change if any of these
 * no longer match, so a second person's edit in between is never overwritten.
 */
// A type alias, not an interface: it is sent as the RPC's jsonb argument,
// and only an alias is assignable to the generated Json index signature.
export type PaymentSnapshot = {
  amount_php: number;
  method: string | null;
  reference_number: string | null;
  notes: string | null;
  visit_id?: string;
};

export function paymentSnapshot(p: {
  amount_php: number | string;
  method: string | null;
  reference_number: string | null;
  notes: string | null;
  visit_id?: string;
}): PaymentSnapshot {
  const text = (v: string | null) => (v && v.trim() !== "" ? v.trim() : null);
  return {
    amount_php: Number(p.amount_php),
    method: p.method,
    reference_number: text(p.reference_number),
    notes: text(p.notes),
    ...(p.visit_id ? { visit_id: p.visit_id } : {}),
  };
}

/**
 * What is left to pay on a visit after its paid total moves by `paidDelta`
 * (negative = a payment leaves it). Centavo arithmetic; negative = overpaid.
 */
export function visitBalanceAfter(visitTotal: number, visitPaid: number, paidDelta: number): number {
  return (toCentavos(visitTotal) - toCentavos(visitPaid) - toCentavos(paidDelta)) / 100;
}

/**
 * je_period_lock_check (0029) refuses a money Edit or Move of a payment
 * received in a closed accounting month: the corrected payment's journal
 * entry posts on the ORIGINAL received date. Delete still works — its
 * reversal posts today — so say that instead of the raw "Cannot modify
 * journal entry dated …".
 */
export const CLOSED_MONTH_MESSAGE =
  "This payment was received in a month the books are already closed for, so it cannot be edited or moved. Delete it and record it again (the correction then lands in this month), or ask an admin to reopen that month.";

// ---------------------------------------------------------------------------
// When a payment leaves a visit (Delete, or the source side of a Move).
//
// Released results stay released (owner rule): nothing here undoes a release
// or hides a result. These helpers only let the dialogs and the visit page SAY
// what the visit is left in, using the database's own reading of it — the
// status recalc_visit_payment (0111) will write, then moneySettled().
// ---------------------------------------------------------------------------

/** The visit money a preview needs, as the page loaded it. */
export interface VisitMoney {
  totalPhp: number;
  paidPhp: number;
  paymentStatus: string;
  hmoProviderId: string | null;
}

/**
 * payment_status after the visit's paid total moves by `paidDelta`, exactly as
 * recalc_visit_payment (0111) computes it: a waived visit stays waived, a ₱0
 * bill or a covered one is paid, anything in between is partial.
 */
export function paymentStatusAfter(v: VisitMoney, paidDelta: number): string {
  if (v.paymentStatus === "waived") return "waived";
  const total = toCentavos(v.totalPhp);
  const paid = toCentavos(v.paidPhp) + toCentavos(paidDelta);
  if (total === 0 || paid >= total) return "paid";
  if (paid > 0) return "partial";
  return "unpaid";
}

/** Is the visit's money still settled (money-settled.ts) after `paidDelta`? */
export function settledAfter(v: VisitMoney, paidDelta: number): boolean {
  return moneySettled({
    payment_status: paymentStatusAfter(v, paidDelta),
    hmo_provider_id: v.hmoProviderId,
  });
}

/** Released lines on a visit, split the way reception talks about them. */
export interface ReleasedCounts {
  /** Lab and imaging results — never package headers, never doctor lines. */
  results: number;
  consults: number;
  procedures: number;
}

export const NO_RELEASED: ReleasedCounts = { results: 0, consults: 0, procedures: 0 };

export interface ReleasableLine {
  status: string;
  is_package_header: boolean;
  /** services.kind; an unknown kind reads as a lab result (classifyKind). */
  kind: string | null | undefined;
}

/**
 * Count the released lines. A package header is a billing wrapper, not a
 * result (its components are counted), and a doctor consult or procedure is
 * not a result either (DOCTOR_KIND_VALUES), so they are counted apart.
 */
export function countReleasedLines(lines: readonly ReleasableLine[]): ReleasedCounts {
  const out = { ...NO_RELEASED };
  for (const l of lines) {
    if (l.status !== "released" || l.is_package_header) continue;
    const cls = classifyKind(l.kind ?? "");
    if (cls === "consult") out.consults += 1;
    else if (cls === "procedure") out.procedures += 1;
    else out.results += 1;
  }
  return out;
}

export function releasedTotal(c: ReleasedCounts): number {
  return c.results + c.consults + c.procedures;
}

// ---------------------------------------------------------------------------
// "Completed work" — the one predicate behind the released-and-owing alert,
// the Patient AR "Completed work" filter and the queue / Patient AR badges.
// A released lab or imaging result AND a doctor consult or procedure marked
// done both count: the patient has had the service either way, so a visit
// that owes again with any of them is the exception these surfaces flag.
// countReleasedLines keeps the split (results are worded apart from doctor
// lines); this is the total of it.
// ---------------------------------------------------------------------------

/** Released results + done doctor lines on a visit, from rows already loaded. */
export function completedWorkCount(lines: readonly ReleasableLine[]): number {
  return releasedTotal(countReleasedLines(lines));
}

/**
 * "3 results released", "1 doctor consult done", "2 results released, 1
 * doctor consult and 1 procedure done" — the row value in the alert email.
 * Empty when nothing is completed.
 */
export function completedWorkSummary(c: ReleasedCounts): string {
  const parts: string[] = [];
  if (c.results > 0) parts.push(`${plural(c.results, "result")} released`);
  const doctor = doctorPhrase(c);
  if (doctor) parts.push(`${doctor} done`);
  return parts.join(", ");
}

/**
 * The "after its …" clause of the alert subject: "its results went out",
 * "its doctor consult was done", or both. Empty when nothing is completed.
 */
export function completedWorkWentPhrase(c: ReleasedCounts): string {
  const results = c.results > 0;
  const doctor = c.consults + c.procedures;
  if (results && doctor > 0) return "its results went out and its doctor lines were done";
  if (results) return "its results went out";
  if (doctor === 0) return "";
  if (c.consults > 0 && c.procedures > 0) return "its doctor lines were done";
  const noun = c.consults > 0 ? "doctor consult" : "doctor procedure";
  return doctor === 1 ? `its ${noun} was done` : `its ${noun}s were done`;
}

/**
 * What the visit is left in once `amount` leaves it — the dialog preview.
 * The void action re-reads the visit afterwards for its audit row; this is
 * only what the page saw.
 *
 *   null     — still settled (e.g. a payment recorded twice), or nothing to say
 *   owes     — an ordinary visit that will be unpaid/partial again
 *   hmo      — billed to an HMO: its releases were never gated on payment
 *   waived   — stays waived; the money is simply no longer tracked anywhere
 */
export type PaymentLeavesState =
  | { kind: "owes"; balancePhp: number; released: ReleasedCounts }
  | { kind: "hmo"; released: ReleasedCounts }
  | { kind: "waived"; untrackedPhp: number; released: ReleasedCounts };

export function paymentLeavesState(
  v: VisitMoney,
  amount: number,
  released: ReleasedCounts,
): PaymentLeavesState | null {
  if (v.hmoProviderId !== null) {
    // An HMO visit releases unpaid by design (0133). Deleting a co-pay never
    // puts its results in question, so only say how they went out — and a
    // doctor consult done on an HMO visit is not worth a sentence at all.
    return released.results > 0 ? { kind: "hmo", released } : null;
  }
  const before = Math.max(visitBalanceAfter(v.totalPhp, v.paidPhp, 0), 0);
  const after = Math.max(visitBalanceAfter(v.totalPhp, v.paidPhp, -amount), 0);
  if (v.paymentStatus === "waived") {
    const untracked = (toCentavos(after) - toCentavos(before)) / 100;
    return untracked > 0 ? { kind: "waived", untrackedPhp: untracked, released } : null;
  }
  if (settledAfter(v, -amount)) return null;
  return { kind: "owes", balancePhp: after, released };
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "1 doctor consult", "2 doctor consults and 1 procedure", or "" when none. */
function doctorPhrase(c: ReleasedCounts): string {
  const parts: string[] = [];
  if (c.consults > 0) parts.push(plural(c.consults, "doctor consult"));
  if (c.procedures > 0) parts.push(plural(c.procedures, c.consults > 0 ? "procedure" : "doctor procedure"));
  return joinAnd(parts);
}

/**
 * "2 results on it are already released", "the doctor consult on it is
 * already done", or both joined. Empty when nothing is released.
 */
export function releasedOnItPhrase(c: ReleasedCounts): string {
  const clauses: string[] = [];
  if (c.results > 0) {
    clauses.push(`${plural(c.results, "result")} on it ${c.results === 1 ? "is" : "are"} already released`);
  }
  const doctor = doctorPhrase(c);
  if (doctor) {
    const n = c.consults + c.procedures;
    clauses.push(`${doctor}${c.results > 0 ? "" : " on it"} ${n === 1 ? "is" : "are"} already done`);
  }
  return joinAnd(clauses);
}

/**
 * The sentence the Delete and Move dialogs show. `emphasis` is true when
 * something already left the building, so the dialog can make it stand out.
 */
export function paymentLeavesMessage(
  state: PaymentLeavesState,
  visitNumber: string,
  formatPhp: (n: number) => string,
): { text: string; emphasis: boolean } {
  const released = releasedOnItPhrase(state.released);
  const any = released !== "";
  switch (state.kind) {
    case "owes":
      return {
        text: `Visit #${visitNumber} will then owe ${formatPhp(state.balancePhp)}${
          any ? `, and ${released}. Released results stay released.` : "."
        }`,
        emphasis: any,
      };
    case "hmo":
      return {
        text: `Visit #${visitNumber} is billed to an HMO, so its ${plural(state.released.results, "result")} ${
          state.released.results === 1 ? "was" : "were"
        } released under HMO billing and stay${state.released.results === 1 ? "s" : ""} released.`,
        emphasis: false,
      };
    case "waived":
      return {
        text: `Visit #${visitNumber} stays waived; the ${formatPhp(state.untrackedPhp)} is no longer tracked in Patient AR${
          any ? `. ${capitalise(released)}, and released results stay released.` : "."
        }`,
        emphasis: any,
      };
  }
}

/**
 * The visit page's note for a visit whose results went out (or doctor lines
 * were done) while it was paid and which now owes money again — a payment
 * deleted, edited down or moved since. Null when that is not the case: a settled visit, an HMO
 * visit (it releases unpaid by design) or one with nothing released.
 */
export function releasedWhileUnpaidMessage(
  v: VisitMoney,
  released: ReleasedCounts,
  formatPhp: (n: number) => string,
): string | null {
  if (moneySettled({ payment_status: v.paymentStatus, hmo_provider_id: v.hmoProviderId })) return null;
  if (releasedTotal(released) === 0) return null;
  const went: string[] = [];
  if (released.results > 0) went.push(`${plural(released.results, "result")} went out`);
  const doctor = doctorPhrase(released);
  if (doctor) went.push(`${doctor} ${released.consults + released.procedures === 1 ? "was" : "were"} done`);
  const owes = Math.max(visitBalanceAfter(v.totalPhp, v.paidPhp, 0), 0);
  return `${capitalise(joinAnd(went))} while this visit was paid; it now owes ${formatPhp(owes)}.`;
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
