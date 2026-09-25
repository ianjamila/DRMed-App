"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PaymentEditSchema } from "@/lib/validations/payment";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CLOSED_MONTH_MESSAGE,
  isMoneyChange,
  NO_RELEASED,
  paymentEditability,
  releasedTotal,
  type PaymentSnapshot,
  type ReleasedCounts,
} from "@/lib/visits/payment-edit";
import { paymentMethodLabel } from "@/lib/visits/payment-history";
import { moneySettled } from "@/lib/visits/money-settled";
import { loadCompletedWorkCounts } from "@/lib/visits/released-results";
import { shouldAlertPaymentEdited } from "@/lib/visits/released-payment-alert-content";
import { sendReleasedPaymentRemovedAlert } from "@/lib/visits/released-payment-alert";
import { assertVisitPatientActive } from "@/lib/patients/require-active";

export type EditPaymentResult = { ok: true } | { ok: false; error: string };

// Same role pair as canVoidPayment in ../void/actions.ts — an edit voids the
// original, so it can never be wider than Delete.
function canEditPayment(role: string): boolean {
  return role === "reception" || role === "admin";
}

export async function editPaymentAction(input: {
  paymentId: string;
  amount: string;
  method: string;
  referenceNumber: string;
  notes: string;
  reason: string;
  /** The payment as the dialog showed it — refused if it changed since (0174). */
  expected: PaymentSnapshot;
}): Promise<EditPaymentResult> {
  const session = await requireActiveStaff();
  if (!canEditPayment(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = PaymentEditSchema.safeParse({
    payment_id: input.paymentId,
    amount_php: input.amount,
    method: input.method,
    reference_number: input.referenceNumber,
    notes: input.notes,
    reason: input.reason,
    expected: input.expected,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const d = parsed.data;

  const admin = createAdminClient();

  // Read first for the audit's before-state and a friendly early refusal.
  // correct_payment re-checks all of it under a row lock, so a race between
  // this read and the RPC is still refused there.
  const { data: before, error: readErr } = await admin
    .from("payments")
    .select("id, visit_id, amount_php, method, reference_number, notes, voided_at, legacy_import_run_id, visits ( patient_id )")
    .eq("id", d.payment_id)
    .maybeSingle();
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  if (!before) return { ok: false, error: "Payment not found." };
  const editability = paymentEditability(before);
  if (!editability.editable) return { ok: false, error: editability.reason };

  // 0167: no financial reversal on an inactive record — restore it first.
  const active = await assertVisitPatientActive(admin, before.visit_id);
  if (!active.ok) return { ok: false, error: active.error };

  const moneyChanged = isMoneyChange(
    { amount_php: Number(before.amount_php), method: before.method },
    { amount_php: d.amount_php, method: d.method },
  );

  const { data: activePaymentId, error: rpcErr } = await admin.rpc("correct_payment", {
    p_payment_id: d.payment_id,
    p_amount_php: d.amount_php,
    p_method: d.method,
    p_reference_number: d.reference_number,
    p_notes: d.notes,
    p_reason: d.reason,
    p_actor_id: session.user_id,
    p_expected: { ...d.expected, visit_id: before.visit_id },
  });
  if (rpcErr) {
    return {
      ok: false,
      error: rpcErr.code === "P0002" ? CLOSED_MONTH_MESSAGE : translatePgError(rpcErr),
    };
  }

  // What the visit is in now — re-read after the RPC (recalc_visit_payment
  // has written the real status), the same fields the Delete and Move audits
  // carry. Only a money change can move it; a reference/notes edit leaves the
  // visit as it was and skips the read. Best-effort: a failed read leaves the
  // fields null and sends no alert, never drops the audit row.
  let settledAfter: boolean | null = null;
  let completed: ReleasedCounts | null = null;
  if (moneyChanged) {
    const [{ data: visitAfter }, work] = await Promise.all([
      admin
        .from("visits")
        .select("payment_status, hmo_provider_id")
        .eq("id", before.visit_id)
        .is("deleted_at", null)
        .maybeSingle(),
      loadCompletedWorkCounts(admin, [before.visit_id]).catch(() => null),
    ]);
    if (visitAfter) settledAfter = moneySettled(visitAfter);
    if (work) completed = work.get(before.visit_id) ?? NO_RELEASED;
  }
  const completedWork = completed ? releasedTotal(completed) : null;

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.edited",
    resource_type: "payment",
    resource_id: d.payment_id,
    metadata: {
      visit_id: before.visit_id,
      reason: d.reason,
      // A money change voids this payment and records `new_payment_id`; a
      // reference/notes change edits it in place (new_payment_id = itself).
      money_changed: moneyChanged,
      new_payment_id: activePaymentId,
      // Null on a reference/notes-only edit (the visit's money did not move).
      released_count: completed ? completed.results : null,
      completed_work: completedWork,
      settled_after: settledAfter,
      before: {
        amount_php: Number(before.amount_php),
        method: before.method,
        reference_number: before.reference_number,
        notes: before.notes,
      },
      after: {
        amount_php: d.amount_php,
        method: d.method,
        reference_number: d.reference_number || null,
        notes: d.notes || null,
      },
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Email Alerts (0178): the amount came down and the visit owes again after
  // work on it was completed — the same alert Delete and Move send. after()
  // — once the response is sent, so it never slows the edit.
  if (
    completed &&
    shouldAlertPaymentEdited({
      moneyChanged,
      oldAmountPhp: Number(before.amount_php),
      newAmountPhp: d.amount_php,
      settledAfter,
      completedWork,
    })
  ) {
    const work = completed;
    after(() =>
      sendReleasedPaymentRemovedAlert({
        paymentId: d.payment_id,
        change: "edited",
        visitId: before.visit_id,
        amountPhp: Number(before.amount_php),
        methodLabel: paymentMethodLabel(before.method),
        reasonLabel: null,
        movedToVisitNumber: null,
        editedTo: { amountPhp: d.amount_php, methodLabel: paymentMethodLabel(d.method) },
        actorId: session.user_id,
        completed: work,
      }),
    );
  }

  revalidatePath(`/staff/visits/${before.visit_id}`);
  const visit = Array.isArray(before.visits) ? before.visits[0] : before.visits;
  if (visit?.patient_id) revalidatePath(`/staff/patients/${visit.patient_id}`);
  return { ok: true };
}
