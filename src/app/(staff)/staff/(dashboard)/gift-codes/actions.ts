"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { SellGiftCodeSchema } from "@/lib/validations/gift-code";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { todayManilaISODate } from "@/lib/dates/manila";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type SellResult = { ok: true } | { ok: false; error: string };

function requireReception(role: StaffSession["role"]): boolean {
  return role === "reception" || role === "admin";
}

export async function sellGiftCodeAction(
  _prev: SellResult | null,
  formData: FormData,
): Promise<SellResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = SellGiftCodeSchema.safeParse({
    code: formData.get("code"),
    buyer_name: formData.get("buyer_name"),
    buyer_contact: formData.get("buyer_contact"),
    purchase_method: formData.get("purchase_method"),
    purchase_reference_number: formData.get("purchase_reference_number"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  const { data: code } = await admin
    .from("gift_codes")
    .select("id, status, face_value_php, notes")
    .eq("code", parsed.data.code)
    .maybeSingle();
  if (!code) {
    return { ok: false, error: "No gift code found with that number." };
  }
  if (code.status !== "generated") {
    return {
      ok: false,
      error:
        code.status === "purchased"
          ? "This code has already been sold."
          : code.status === "redeemed"
            ? "This code has already been redeemed."
            : "This code has been cancelled and cannot be sold.",
    };
  }

  const { data: sold, error } = await admin
    .from("gift_codes")
    .update({
      status: "purchased",
      purchased_at: new Date().toISOString(),
      purchased_by_name: parsed.data.buyer_name,
      purchased_by_contact: parsed.data.buyer_contact,
      purchase_method: parsed.data.purchase_method,
      purchase_reference_number: parsed.data.purchase_reference_number,
      sold_by: session.user_id,
      // Concat user notes onto whatever admin set at generation, if any.
      // The admin notes are preserved on the row already; appending here
      // would clobber them, so we only write notes when reception added some.
      ...(parsed.data.notes
        ? { notes: parsed.data.notes }
        : {}),
    })
    .eq("id", code.id)
    .eq("status", "generated") // optimistic concurrency: protects against double-sale
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: translatePgError(error) };
  if (!sold) {
    // The generated→purchased guard matched zero rows: someone else sold this
    // code between the read above and this write.
    return { ok: false, error: "This code has already been sold." };
  }

  // N14: a CASH sale takes real money over the counter but isn't tied to a
  // visit (0014 removed payments.visit_id's nullability on purpose), so it
  // can't go through the payments table. eod_cash_adjustments (0139) is the
  // table that already exists for exactly this — cash movements with no
  // payments row — reused here with kind='gift_code_sale' so the EOD drawer's
  // expected_cash_php counts this cash exactly once, at sale. Non-cash sales
  // (gcash/maya/card/bank_transfer) don't touch the drawer at all — nothing
  // physical to reconcile.
  if (parsed.data.purchase_method === "cash") {
    const { data: shift } = await admin
      .from("cash_shifts")
      .select("id")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true })
      .limit(1)
      .maybeSingle();

    const adjErr = shift
      ? (
          await admin.from("eod_cash_adjustments").insert({
            business_date: todayManilaISODate(),
            shift_id: shift.id,
            kind: "gift_code_sale",
            gift_code_id: code.id,
            amount_php: code.face_value_php,
            payee: parsed.data.buyer_name,
            notes: `Gift code ${parsed.data.code} sold to ${parsed.data.buyer_name}`,
            recorded_by: session.user_id,
          })
        ).error
      : null;

    if (!shift || adjErr) {
      // Don't leave a "sold" code with no drawer entry — put it back exactly
      // as it was (status + every purchase field) so the sale genuinely did
      // not happen, and reception sees why (e.g. EOD already closed for
      // today — the same P0015 a cash payment would hit).
      await admin
        .from("gift_codes")
        .update({
          status: "generated",
          purchased_at: null,
          purchased_by_name: null,
          purchased_by_contact: null,
          purchase_method: null,
          purchase_reference_number: null,
          sold_by: null,
          // Restore whatever notes existed before this attempt — we only
          // overwrote them above if reception typed sale notes.
          ...(parsed.data.notes ? { notes: code.notes } : {}),
        })
        .eq("id", code.id);
      return {
        ok: false,
        error: adjErr
          ? translatePgError(adjErr)
          : "No active cash shift is configured — ask an admin to check cash-drawer setup.",
      };
    }
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "gift_code.sold",
    resource_type: "gift_code",
    resource_id: code.id,
    metadata: {
      code: parsed.data.code,
      face_value_php: code.face_value_php,
      buyer_name: parsed.data.buyer_name,
      method: parsed.data.purchase_method,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/gift-codes/sell");
  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/admin/gift-codes");
  redirect(
    `/staff/gift-codes/sell?sold=${encodeURIComponent(parsed.data.code)}`,
  );
}
