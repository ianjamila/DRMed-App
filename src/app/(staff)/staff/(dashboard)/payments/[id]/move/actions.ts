"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { moneySettled } from "@/lib/visits/money-settled";
import { loadCompletedWorkCounts } from "@/lib/visits/released-results";
import { paymentMethodLabel } from "@/lib/visits/payment-history";
import { shouldAlertReleasedPaymentRemoved } from "@/lib/visits/released-payment-alert-content";
import { sendReleasedPaymentRemovedAlert } from "@/lib/visits/released-payment-alert";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CLOSED_MONTH_MESSAGE,
  NO_RELEASED,
  paymentEditability,
  paymentSnapshot,
  releasedTotal,
} from "@/lib/visits/payment-edit";

// Same role pair as Edit and Delete (payments/[id]/{edit,void}/actions.ts).
function canMovePayment(role: string): boolean {
  return role === "reception" || role === "admin";
}

export interface MoveTarget {
  id: string;
  visitNumber: string;
  visitDate: string;
  patientName: string;
  drmId: string;
  totalPhp: number;
  paidPhp: number;
}

export type FindVisitResult = { ok: true; visit: MoveTarget } | { ok: false; error: string };

/**
 * Resolve a typed visit number to a live visit for the Move dialog. Read
 * through the RLS client — the same visit + patient name any staff member
 * already sees on the visit page.
 */
export async function findVisitForMoveAction(visitNumber: string): Promise<FindVisitResult> {
  const session = await requireActiveStaff();
  if (!canMovePayment(session.role)) return { ok: false, error: "Forbidden." };

  const n = visitNumber.trim().replace(/^#/, "");
  if (!n) return { ok: false, error: "Type a visit number." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("visits")
    .select("id, visit_number, visit_date, total_php, paid_php, patients ( first_name, last_name, drm_id )")
    .eq("visit_number", n)
    // A deleted visit cannot take a payment (P0045); say so here instead.
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) return { ok: false, error: `No open visit #${n}. Check the number, or restore the visit first.` };
  const pt = Array.isArray(data.patients) ? data.patients[0] : data.patients;
  return {
    ok: true,
    visit: {
      id: data.id,
      visitNumber: data.visit_number,
      visitDate: data.visit_date,
      patientName: pt ? `${pt.last_name}, ${pt.first_name}` : "—",
      drmId: pt?.drm_id ?? "",
      totalPhp: Number(data.total_php),
      paidPhp: Number(data.paid_php),
    },
  };
}

const MovePaymentSchema = z.object({
  payment_id: z.string().uuid(),
  target_visit_id: z.string().uuid("Choose the visit to move it to."),
  reason: z.string().trim().min(1, "Reason is required to move a payment.").max(500),
});

export type MovePaymentResult = { ok: true } | { ok: false; error: string };

export async function movePaymentAction(input: {
  paymentId: string;
  targetVisitId: string;
  reason: string;
}): Promise<MovePaymentResult> {
  const session = await requireActiveStaff();
  if (!canMovePayment(session.role)) return { ok: false, error: "Forbidden." };

  const parsed = MovePaymentSchema.safeParse({
    payment_id: input.paymentId,
    target_visit_id: input.targetVisitId,
    reason: input.reason,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;

  const admin = createAdminClient();
  const { data: before, error: readErr } = await admin
    .from("payments")
    .select(
      "id, visit_id, amount_php, method, reference_number, notes, voided_at, legacy_import_run_id, visits ( patient_id )",
    )
    .eq("id", d.payment_id)
    .maybeSingle();
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  if (!before) return { ok: false, error: "Payment not found." };
  const editability = paymentEditability(before, "moved");
  if (!editability.editable) return { ok: false, error: editability.reason };
  if (before.visit_id === d.target_visit_id) {
    return { ok: false, error: "The payment is already on that visit." };
  }

  const { data: target } = await admin
    .from("visits")
    .select("id, patient_id, visit_number")
    .eq("id", d.target_visit_id)
    // A deleted target is refused by correct_payment; this read only feeds
    // the audit row and revalidation.
    .is("deleted_at", null)
    .maybeSingle();

  // Same amount, method, reference and notes — only the visit changes.
  const { data: newPaymentId, error: rpcErr } = await admin.rpc("correct_payment", {
    p_payment_id: d.payment_id,
    p_amount_php: Number(before.amount_php),
    p_method: before.method ?? "",
    p_reference_number: before.reference_number ?? "",
    p_notes: before.notes ?? "",
    p_reason: d.reason,
    p_actor_id: session.user_id,
    p_visit_id: d.target_visit_id,
    // Refused under the row lock if anything changed since the read above, so
    // a reference fix saved in between is never copied over (0174).
    p_expected: paymentSnapshot(before),
  });
  if (rpcErr) {
    return {
      ok: false,
      error: rpcErr.code === "P0002" ? CLOSED_MONTH_MESSAGE : translatePgError(rpcErr),
    };
  }

  const fromVisit = Array.isArray(before.visits) ? before.visits[0] : before.visits;

  // What the visit the payment LEFT is now in — re-read after the move, the
  // same fields the Delete audit carries. Best-effort: a failed read leaves
  // them null and sends no alert, never drops the audit row.
  const [{ data: sourceAfter }, sourceWork] = await Promise.all([
    admin
      .from("visits")
      .select("payment_status, hmo_provider_id")
      .eq("id", before.visit_id)
      .is("deleted_at", null)
      .maybeSingle(),
    loadCompletedWorkCounts(admin, [before.visit_id]).catch(() => null),
  ]);
  const settledAfter = sourceAfter ? moneySettled(sourceAfter) : null;
  const completed = sourceWork ? (sourceWork.get(before.visit_id) ?? NO_RELEASED) : null;
  const completedWork = completed ? releasedTotal(completed) : null;

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.moved",
    resource_type: "payment",
    resource_id: d.payment_id,
    metadata: {
      reason: d.reason,
      from_visit_id: before.visit_id,
      to_visit_id: d.target_visit_id,
      new_payment_id: newPaymentId,
      amount_php: Number(before.amount_php),
      method: before.method,
      cross_patient: fromVisit?.patient_id !== target?.patient_id,
      source_released_count: completed ? completed.results : null,
      source_completed_work: completedWork,
      source_settled_after: settledAfter,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Email Alerts (0178): the source visit owes again after work on it was
  // completed. after() — once the response is sent, so it never slows the move.
  if (completed && shouldAlertReleasedPaymentRemoved({ settledAfter, completedWork })) {
    const work = completed;
    after(() =>
      sendReleasedPaymentRemovedAlert({
        paymentId: d.payment_id,
        change: "moved",
        visitId: before.visit_id,
        amountPhp: Number(before.amount_php),
        methodLabel: paymentMethodLabel(before.method),
        reasonLabel: null,
        movedToVisitNumber: target?.visit_number ?? null,
        editedTo: null,
        actorId: session.user_id,
        completed: work,
      }),
    );
  }

  revalidatePath(`/staff/visits/${before.visit_id}`);
  revalidatePath(`/staff/visits/${d.target_visit_id}`);
  if (fromVisit?.patient_id) revalidatePath(`/staff/patients/${fromVisit.patient_id}`);
  if (target?.patient_id) revalidatePath(`/staff/patients/${target.patient_id}`);
  return { ok: true };
}
