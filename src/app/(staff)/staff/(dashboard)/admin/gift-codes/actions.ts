"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { generateGiftCodes } from "@/lib/gift-codes/generate";
import {
  CancelGiftCodeSchema,
  GenerateBatchSchema,
} from "@/lib/validations/gift-code";

export type GiftCodeResult =
  | { ok: true }
  | { ok: false; error: string };

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function generateBatchAction(
  _prev: GiftCodeResult | null,
  formData: FormData,
): Promise<GiftCodeResult> {
  const session = await requireAdminStaff();
  const parsed = GenerateBatchSchema.safeParse({
    count: formData.get("count"),
    face_value_php: formData.get("face_value_php"),
    batch_label: formData.get("batch_label"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { count, face_value_php, batch_label, notes } = parsed.data;

  // Generate with one round of conflict retry. Collisions across 60-bit
  // codes are vanishingly rare, but the retry keeps us robust against
  // pathological luck or test fixtures.
  let attempts = 0;
  const maxAttempts = 3;
  let inserted = 0;
  const insertedCodes: string[] = [];

  while (inserted < count && attempts < maxAttempts) {
    attempts += 1;
    const remaining = count - inserted;
    const codes = generateGiftCodes(remaining);
    const rows = codes.map((code) => ({
      code,
      face_value_php,
      batch_label,
      notes,
      generated_by: session.user_id,
    }));
    const { data, error } = await admin
      .from("gift_codes")
      .insert(rows)
      .select("code");
    if (error && error.code !== "23505") {
      return { ok: false, error: error.message };
    }
    if (data) {
      inserted += data.length;
      for (const r of data) insertedCodes.push(r.code);
    }
  }

  if (inserted < count) {
    return {
      ok: false,
      error: `Generated ${inserted} of ${count} codes; please try the remaining ${count - inserted} again.`,
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "gift_code.batch_generated",
    resource_type: "gift_code_batch",
    resource_id: batch_label ?? null,
    metadata: {
      count,
      face_value_php,
      batch_label,
      sample_first: insertedCodes[0] ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/gift-codes");
  const target = batch_label
    ? `/staff/admin/gift-codes?batch_label=${encodeURIComponent(batch_label)}`
    : "/staff/admin/gift-codes";
  redirect(target);
}

export async function cancelGiftCodeAction(
  giftCodeId: string,
  _prev: GiftCodeResult | null,
  formData: FormData,
): Promise<GiftCodeResult> {
  const session = await requireAdminStaff();
  const parsed = CancelGiftCodeSchema.safeParse({
    cancellation_reason: formData.get("cancellation_reason"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: current } = await admin
    .from("gift_codes")
    .select("status, code")
    .eq("id", giftCodeId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Gift code not found." };
  if (current.status === "redeemed") {
    return {
      ok: false,
      error: "Already-redeemed codes cannot be cancelled.",
    };
  }
  if (current.status === "cancelled") {
    return { ok: false, error: "This code is already cancelled." };
  }

  const { error } = await admin
    .from("gift_codes")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: session.user_id,
      cancellation_reason: parsed.data.cancellation_reason,
    })
    .eq("id", giftCodeId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "gift_code.cancelled",
    resource_type: "gift_code",
    resource_id: giftCodeId,
    metadata: {
      code: current.code,
      previous_status: current.status,
      reason: parsed.data.cancellation_reason,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/gift-codes");
  return { ok: true };
}
