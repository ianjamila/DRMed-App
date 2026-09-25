"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { VoidPaymentSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reverseJournalEntryBySource } from "@/lib/accounting/journal-entry";
import {
  DELETE_CATEGORY_LABEL,
  formatDeleteReason,
  paymentMethodLabel,
  type DeleteCategory,
} from "@/lib/visits/payment-history";
import { shouldAlertReleasedPaymentRemoved } from "@/lib/visits/released-payment-alert-content";
import { sendReleasedPaymentRemovedAlert } from "@/lib/visits/released-payment-alert";
import { moneySettled } from "@/lib/visits/money-settled";
import { loadCompletedWorkCounts } from "@/lib/visits/released-results";
import { NO_RELEASED, releasedTotal, type ReleasedCounts } from "@/lib/visits/payment-edit";

// "Voided" is not a word staff see (the button says Delete), and the row may
// equally have been edited or moved (both void it) by someone else. Not
// exported: a "use server" module may only export async functions.
const ALREADY_CHANGED = "Someone else already deleted, edited or moved this payment. Refresh the visit.";

export type VoidResult = { ok: true } | { ok: false; error: string };

// A6 (go-live): reception + admin only, by owner decision. RLS already
// denies medtech/pathologist/xray_technician SELECT/UPDATE on `payments`
// (0001: "payments: reception/admin manage"), so this is defense-in-depth
// rather than a live click path — but requireActiveStaff() alone let ANY
// active staff role call this action. Mirrors canManagePettyCash in
// payments/petty-cash/actions.ts (same role pair, same money-action shape).
function canVoidPayment(role: string): boolean {
  return role === "reception" || role === "admin";
}

export async function voidPaymentAction(
  paymentId: string,
  input: { category: DeleteCategory; reason: string },
): Promise<VoidResult> {
  const session = await requireActiveStaff();
  if (!canVoidPayment(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = VoidPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Reason is required.",
    };
  }
  // "Recorded twice: <note>" — the same prefix scheme as correct_payment's
  // "Edited: " / "Moved: " (payment-history.ts parses it back).
  const voidReason = formatDeleteReason(parsed.data.category, parsed.data.reason);

  const admin = createAdminClient();

  // 1. Read payment to check state.
  const { data: payment, error: readErr } = await admin
    .from("payments")
    .select("id, visit_id, voided_at, amount_php, method, visits ( patient_id )")
    .eq("id", paymentId)
    .maybeSingle();
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.voided_at) return { ok: false, error: ALREADY_CHANGED };

  // 2. Flip voided_at FIRST — bridge trigger emits the reversal JE. This is
  // the write that can be refused: `trg_payments_block_after_close_iu`
  // fires BEFORE UPDATE against the payment's `received_at` day and raises
  // P0015 when that day is closed. Finding 2 (go-live review): this used to
  // run AFTER the gift-code reset and breakage reversal below, so an
  // ordinary admin voiding a redemption after the day closed would already
  // have reset the code and reversed the journal entry by the time this
  // update failed — leaving the two accounts reversed while the payment
  // still stood, with the admin seeing only "day is closed". Voiding first
  // means nothing downstream is mutated until this write has succeeded.
  const { data: voidedRows, error: voidErr } = await admin
    .from("payments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: voidReason,
    })
    .eq("id", paymentId)
    .is("voided_at", null) // a second concurrent void matches no row…
    .select("id");
  if (voidErr) return { ok: false, error: translatePgError(voidErr) };
  // …and neither does one racing an Edit or Move (correct_payment voided the
  // row between the read above and this update). Nothing was deleted here, so
  // report that instead of success, and write no `payment.voided` audit row
  // for a delete that did not happen.
  if (!voidedRows || voidedRows.length === 0) {
    return {
      ok: false,
      error: ALREADY_CHANGED,
    };
  }

  // 3. Reset any gift code that was redeemed against this payment.
  // NOTE: This reset and the void above are two separate DB writes — not
  // wrapped in a single transaction. The payment is now voided even if this
  // step below fails, which is the safer direction: a payment that stays
  // voided with a gift code that failed to reset back to 'purchased' is an
  // investigable admin-report gap, not a "results release for free" hole.
  // Accepted trade-off for 12.2; a follow-up could wrap both calls in a
  // Postgres RPC for full atomicity. Any failure here is captured rather
  // than returned immediately, so step 4 still audits the void that already
  // happened — an early return here would have left a real write (the void)
  // un-audited.
  const { data: redeemedCode } = await admin
    .from("gift_codes")
    .select("id, status")
    .eq("redeemed_payment_id", paymentId)
    .maybeSingle();
  let giftCodeError: string | null = null;
  if (redeemedCode && redeemedCode.status === "redeemed") {
    const { error: gcErr } = await admin
      .from("gift_codes")
      .update({
        status: "purchased",
        redeemed_at: null,
        redeemed_by: null,
        redeemed_visit_id: null,
        redeemed_payment_id: null,
      })
      .eq("id", redeemedCode.id);
    if (gcErr) {
      giftCodeError = translatePgError(gcErr);
    } else {
      // Finding 11 (go-live review): a whole-use voucher redemption may have
      // forfeited a remainder, booked as breakage income at redemption time
      // (source_kind='gift_code_breakage', keyed on the gift code — see
      // payments/new/actions.ts and 0139). Reverse it here too, or voiding
      // the redemption leaves that income booked for a redemption that no
      // longer happened, and 2250 doesn't return to its pre-redemption
      // balance.
      giftCodeError = await reverseJournalEntryBySource(admin, {
        sourceKind: "gift_code_breakage",
        sourceId: redeemedCode.id,
        actorId: session.user_id,
        reason: `Payment voided: ${voidReason}`,
      });
    }
  }

  // 4. What the visit is left in, re-read AFTER the void (the dialog showed a
  // preview; recalc_visit_payment (0111) has now written the real status).
  // Released results stay released — this only records what work on the
  // visit was already completed (results released, doctor lines done).
  // Best-effort: a failed read leaves the fields null, never the audit row out.
  let settledAfter: boolean | null = null;
  let completed: ReleasedCounts | null = null;
  if (payment.visit_id) {
    const [{ data: after }, work] = await Promise.all([
      admin
        .from("visits")
        .select("payment_status, hmo_provider_id")
        .eq("id", payment.visit_id)
        .maybeSingle(),
      loadCompletedWorkCounts(admin, [payment.visit_id]).catch(() => null),
    ]);
    if (after) settledAfter = moneySettled(after);
    if (work) completed = work.get(payment.visit_id) ?? NO_RELEASED;
  }
  const completedWork = completed ? releasedTotal(completed) : null;

  // 5. Audit log — always, since the void in step 2 already happened
  // regardless of how step 3 went.
  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.voided",
    resource_type: "payment",
    resource_id: paymentId,
    metadata: {
      reason: voidReason,
      category: parsed.data.category,
      visit_id: payment.visit_id,
      released_count: completed ? completed.results : null,
      completed_work: completedWork,
      settled_after: settledAfter,
      original_amount_php: Number(payment.amount_php),
      gift_code_reset: redeemedCode && !giftCodeError ? redeemedCode.id : null,
      gift_code_reset_error: giftCodeError,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Email Alerts (0178): the visit owes again after work on it was completed.
  // after() — once the response is sent, so it never slows the delete.
  if (payment.visit_id && completed && shouldAlertReleasedPaymentRemoved({ settledAfter, completedWork })) {
    const visitId = payment.visit_id;
    const work = completed;
    after(() =>
      sendReleasedPaymentRemovedAlert({
        paymentId,
        change: "deleted",
        visitId,
        amountPhp: Number(payment.amount_php),
        methodLabel: paymentMethodLabel(payment.method),
        reasonLabel: DELETE_CATEGORY_LABEL[parsed.data.category],
        movedToVisitNumber: null,
        editedTo: null,
        actorId: session.user_id,
        completed: work,
      }),
    );
  }

  if (giftCodeError) {
    return { ok: false, error: giftCodeError };
  }

  if (payment.visit_id) {
    revalidatePath(`/staff/visits/${payment.visit_id}`);
  }
  // The patient page lists every payment too (0161).
  const visit = Array.isArray(payment.visits) ? payment.visits[0] : payment.visits;
  if (visit?.patient_id) revalidatePath(`/staff/patients/${visit.patient_id}`);
  return { ok: true };
}
