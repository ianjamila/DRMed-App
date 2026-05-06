"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PaymentRecordSchema } from "@/lib/validations/payment";
import { RedeemGiftCodePaymentSchema } from "@/lib/validations/gift-code";

export type PaymentResult = { ok: true } | { ok: false; error: string };

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function recordPaymentAction(
  _prev: PaymentResult | null,
  formData: FormData,
): Promise<PaymentResult> {
  const session = await requireActiveStaff();
  const method = formData.get("method");

  if (method === "gift_code") {
    return redeemGiftCode(session.user_id, formData);
  }

  const parsed = PaymentRecordSchema.safeParse({
    visit_id: formData.get("visit_id"),
    amount_php: formData.get("amount_php"),
    method,
    reference_number: formData.get("reference_number") ?? "",
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payments")
    .insert({
      visit_id: parsed.data.visit_id,
      amount_php: parsed.data.amount_php,
      method: parsed.data.method,
      reference_number: parsed.data.reference_number,
      notes: parsed.data.notes,
      received_by: session.user_id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not record payment." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.recorded",
    resource_type: "payment",
    resource_id: data.id,
    metadata: {
      visit_id: parsed.data.visit_id,
      amount_php: parsed.data.amount_php,
      method: parsed.data.method,
    },
    ip_address: ip,
    user_agent: ua,
  });

  redirect(`/staff/visits/${parsed.data.visit_id}`);
}

async function redeemGiftCode(
  userId: string,
  formData: FormData,
): Promise<PaymentResult> {
  const parsed = RedeemGiftCodePaymentSchema.safeParse({
    visit_id: formData.get("visit_id"),
    code: formData.get("code"),
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  const [{ data: code }, { data: visit }] = await Promise.all([
    admin
      .from("gift_codes")
      .select("id, status, face_value_php")
      .eq("code", parsed.data.code)
      .maybeSingle(),
    admin
      .from("visits")
      .select("id, total_php, paid_php")
      .eq("id", parsed.data.visit_id)
      .maybeSingle(),
  ]);

  if (!code) {
    return { ok: false, error: "No gift code found with that number." };
  }
  if (code.status !== "purchased") {
    return {
      ok: false,
      error:
        code.status === "generated"
          ? "This code hasn't been sold yet — record the sale first."
          : code.status === "redeemed"
            ? "This code has already been redeemed."
            : "This code has been cancelled.",
    };
  }
  if (!visit) {
    return { ok: false, error: "Visit not found." };
  }

  const balance =
    Math.round((Number(visit.total_php) - Number(visit.paid_php)) * 100) / 100;
  if (balance <= 0) {
    return {
      ok: false,
      error: "This visit is already fully paid — nothing to redeem against.",
    };
  }

  // Whole-use voucher: applied amount is min(face_value, balance). The
  // overage (if any) is forfeited — paid_php never exceeds total_php so
  // the visit doesn't show a negative balance. The full face value is
  // still consumed; reception cannot split a code across multiple visits.
  const amountApplied =
    Math.round(Math.min(Number(code.face_value_php), balance) * 100) / 100;

  const { data: payment, error: payErr } = await admin
    .from("payments")
    .insert({
      visit_id: parsed.data.visit_id,
      amount_php: amountApplied,
      method: "gift_code",
      reference_number: parsed.data.code,
      notes: parsed.data.notes,
      received_by: userId,
    })
    .select("id")
    .single();
  if (payErr || !payment) {
    return {
      ok: false,
      error: payErr?.message ?? "Could not record payment.",
    };
  }

  const { error: updErr } = await admin
    .from("gift_codes")
    .update({
      status: "redeemed",
      redeemed_at: new Date().toISOString(),
      redeemed_by: userId,
      redeemed_visit_id: parsed.data.visit_id,
      redeemed_payment_id: payment.id,
    })
    .eq("id", code.id)
    .eq("status", "purchased"); // optimistic concurrency
  if (updErr) {
    // Best-effort rollback so the visit doesn't show a phantom payment.
    await admin.from("payments").delete().eq("id", payment.id);
    return { ok: false, error: updErr.message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: userId,
    actor_type: "staff",
    action: "gift_code.redeemed",
    resource_type: "gift_code",
    resource_id: code.id,
    metadata: {
      code: parsed.data.code,
      visit_id: parsed.data.visit_id,
      payment_id: payment.id,
      face_value_php: code.face_value_php,
      amount_applied_php: amountApplied,
      forfeited_php:
        Math.round((Number(code.face_value_php) - amountApplied) * 100) / 100,
    },
    ip_address: ip,
    user_agent: ua,
  });

  redirect(`/staff/visits/${parsed.data.visit_id}`);
}
