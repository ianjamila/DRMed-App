"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PaymentRecordSchema } from "@/lib/validations/payment";
import { RedeemGiftCodePaymentSchema } from "@/lib/validations/gift-code";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { postSimpleJournalEntry } from "@/lib/accounting/journal-entry";
import { todayManilaISODate } from "@/lib/dates/manila";

export type PaymentResult = { ok: true } | { ok: false; error: string };

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
    // EOD-closure block, JE-edit block etc. surface as raised exceptions —
    // route through translatePgError instead of leaking raw PG text.
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not record payment.",
    };
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

  const forfeitedPhp =
    Math.round((Number(code.face_value_php) - amountApplied) * 100) / 100;

  // Finding 6 (go-live review, blocker): this INSERT is now guarded by
  // payments_gift_code_redemption_unique (0139) — a concurrent redemption of
  // the SAME code fails here with 23505 instead of silently minting a
  // second payment. translatePgError() gives it a friendly message.
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
      error: payErr ? translatePgError(payErr) : "Could not record payment.",
    };
  }

  // Finding 6: check the affected row count, not just the error — a
  // conditional UPDATE that matches zero rows returns no error at all. This
  // catches the code having moved out of 'purchased' between the read above
  // and this write (redeemed by a near-simultaneous request that won the
  // unique-index race above and got here first, or cancelled by an admin in
  // the same window) — cases the unique index alone doesn't cover, since it
  // only protects the `payments` insert, not this gift_codes transition.
  const { data: updatedCode, error: updErr } = await admin
    .from("gift_codes")
    .update({
      status: "redeemed",
      redeemed_at: new Date().toISOString(),
      redeemed_by: userId,
      redeemed_visit_id: parsed.data.visit_id,
      redeemed_payment_id: payment.id,
    })
    .eq("id", code.id)
    .eq("status", "purchased") // optimistic concurrency
    .select("id")
    .maybeSingle();
  if (updErr || !updatedCode) {
    // Best-effort rollback so the visit doesn't show a phantom payment.
    await admin.from("payments").delete().eq("id", payment.id);
    return {
      ok: false,
      error: updErr
        ? translatePgError(updErr)
        : "This code was just redeemed or cancelled by someone else. Refresh and try again.",
    };
  }

  // Finding 11: the payment above already debits 2250 by `amountApplied`
  // via bridge_payment_insert. When the whole-use voucher forfeits a
  // remainder (face value > visit balance), that remainder never gets
  // debited anywhere and 2250 carries it forever. Book it as breakage income
  // now, in the same request, so the two JEs together always drain 2250 by
  // exactly the face value. See 0139's Finding 11 note for the full walk-through.
  if (forfeitedPhp > 0) {
    const { data: outstandingAccount } = await admin
      .from("chart_of_accounts")
      .select("id")
      .eq("code", "2250")
      .single();
    const { data: breakageAccount } = await admin
      .from("chart_of_accounts")
      .select("id")
      .eq("code", "4600")
      .single();

    const jeErr =
      outstandingAccount && breakageAccount
        ? await postSimpleJournalEntry(admin, {
            postingDate: todayManilaISODate(),
            description: `Gift code ${parsed.data.code} redeemed — ₱${forfeitedPhp.toFixed(2)} forfeited`,
            sourceKind: "gift_code_breakage",
            sourceId: code.id,
            debitAccountId: outstandingAccount.id,
            creditAccountId: breakageAccount.id,
            amountPhp: forfeitedPhp,
            createdBy: userId,
          })
        : "Could not find the gift-code accounts. Ask an admin to check the chart of accounts.";

    if (jeErr) {
      // Roll back the whole redemption — the code stays spendable, no
      // phantom payment, no half-booked accounting.
      await admin
        .from("gift_codes")
        .update({
          status: "purchased",
          redeemed_at: null,
          redeemed_by: null,
          redeemed_visit_id: null,
          redeemed_payment_id: null,
        })
        .eq("id", code.id);
      await admin.from("payments").delete().eq("id", payment.id);
      return { ok: false, error: jeErr };
    }
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
      forfeited_php: forfeitedPhp,
    },
    ip_address: ip,
    user_agent: ua,
  });

  redirect(`/staff/visits/${parsed.data.visit_id}`);
}
