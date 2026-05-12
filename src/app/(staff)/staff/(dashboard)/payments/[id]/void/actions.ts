"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { VoidPaymentSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type VoidResult = { ok: true } | { ok: false; error: string };

export async function voidPaymentAction(
  paymentId: string,
  reason: string,
): Promise<VoidResult> {
  const session = await requireActiveStaff();

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
  }

  // 3. Flip voided_at — bridge trigger emits the reversal JE.
  const { error: voidErr } = await admin
    .from("payments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.reason,
    })
    .eq("id", paymentId);
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

  revalidatePath(`/staff/visits/${payment.visit_id}`);
  return { ok: true };
}
