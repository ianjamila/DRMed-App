"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { VoidPaymentSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reverseJournalEntryBySource } from "@/lib/accounting/journal-entry";

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
  reason: string,
): Promise<VoidResult> {
  const session = await requireActiveStaff();
  if (!canVoidPayment(session.role)) {
    return { ok: false, error: "Forbidden." };
  }

  const parsed = VoidPaymentSchema.safeParse({ reason });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Reason is required.",
    };
  }

  const admin = createAdminClient();

  // 1. Read payment to check state.
  const { data: payment, error: readErr } = await admin
    .from("payments")
    .select("id, visit_id, voided_at, amount_php")
    .eq("id", paymentId)
    .maybeSingle();
  if (readErr) return { ok: false, error: translatePgError(readErr) };
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.voided_at) return { ok: false, error: "Payment is already voided." };

  // 2. Reset any gift code that was redeemed against this payment.
  // NOTE: This reset and the void below are two separate DB writes — not
  // wrapped in a single transaction. If the void update fails after this
  // succeeds, the gift code returns to 'purchased' state while the payment
  // is still active. The window is short (one round-trip), and the P0007
  // trigger prevents accidental un-void. Accepted trade-off for 12.2;
  // a follow-up could wrap both calls in a Postgres RPC for full atomicity.
  const { data: redeemedCode } = await admin
    .from("gift_codes")
    .select("id, status")
    .eq("redeemed_payment_id", paymentId)
    .maybeSingle();
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
    if (gcErr) return { ok: false, error: translatePgError(gcErr) };

    // Finding 11 (go-live review): a whole-use voucher redemption may have
    // forfeited a remainder, booked as breakage income at redemption time
    // (source_kind='gift_code_breakage', keyed on the gift code — see
    // payments/new/actions.ts and 0139). Reverse it here too, or voiding the
    // redemption leaves that income booked for a redemption that no longer
    // happened, and 2250 doesn't return to its pre-redemption balance.
    const breakageErr = await reverseJournalEntryBySource(admin, {
      sourceKind: "gift_code_breakage",
      sourceId: redeemedCode.id,
      actorId: session.user_id,
      reason: `Payment voided: ${parsed.data.reason}`,
    });
    if (breakageErr) return { ok: false, error: breakageErr };
  }

  // 3. Flip voided_at — bridge trigger emits the reversal JE.
  const { error: voidErr } = await admin
    .from("payments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.reason,
    })
    .eq("id", paymentId)
    .is("voided_at", null);  // idempotency: second concurrent void is a no-op
  if (voidErr) return { ok: false, error: translatePgError(voidErr) };

  // 4. Audit log.
  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.voided",
    resource_type: "payment",
    resource_id: paymentId,
    metadata: {
      reason: parsed.data.reason,
      original_amount_php: Number(payment.amount_php),
      gift_code_reset: redeemedCode?.id ?? null,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  if (payment.visit_id) {
    revalidatePath(`/staff/visits/${payment.visit_id}`);
  }
  return { ok: true };
}
