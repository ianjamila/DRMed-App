"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PaymentRecordSchema } from "@/lib/validations/payment";

export type PaymentResult = { ok: true } | { ok: false; error: string };

export async function recordPaymentAction(
  _prev: PaymentResult | null,
  formData: FormData,
): Promise<PaymentResult> {
  const session = await requireActiveStaff();

  const parsed = PaymentRecordSchema.safeParse({
    visit_id: formData.get("visit_id"),
    amount_php: formData.get("amount_php"),
    method: formData.get("method"),
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

  const h = await headers();
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
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  redirect(`/staff/visits/${parsed.data.visit_id}`);
}
