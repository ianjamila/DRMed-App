"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { SellGiftCodeSchema, RefundGiftCodeSchema } from "@/lib/validations/gift-code";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { todayManilaISODate } from "@/lib/dates/manila";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  postSimpleJournalEntry,
  reverseJournalEntryBySource,
} from "@/lib/accounting/journal-entry";
import { giftCodeRefundEligibility } from "@/lib/gift-codes/refund";
import type { GiftCodeStatus } from "@/lib/gift-codes/labels";

export type SellResult = { ok: true } | { ok: false; error: string };
export type RefundResult = { ok: true } | { ok: false; error: string };

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

  // Don't leave a "sold" code with no matching accounting entry — put it
  // back exactly as it was (status + every purchase field) so the sale
  // genuinely did not happen, and reception sees why.
  const undoSale = async () => {
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
  };

  // N14: a CASH sale takes real money over the counter but isn't tied to a
  // visit (0014 removed payments.visit_id's nullability on purpose), so it
  // can't go through the payments table. eod_cash_adjustments (0139) is the
  // table that already exists for exactly this — cash movements with no
  // payments row — reused here with kind='gift_code_sale' so the EOD drawer's
  // expected_cash_php counts this cash exactly once, at sale, AND (via
  // bridge_cash_adjustment_insert) posts the sale's DR 1010 / CR 2250 JE.
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
      // e.g. EOD already closed for today — the same P0015 a cash payment
      // would hit.
      await undoSale();
      return {
        ok: false,
        error: adjErr
          ? translatePgError(adjErr)
          : "No active cash shift is configured — ask an admin to check cash-drawer setup.",
      };
    }
  } else {
    // Finding 11 (go-live review): a non-cash sale (gcash/maya/card/
    // bank_transfer) rightly skips the drawer — there's no physical cash to
    // reconcile — but it still took real money, and 2250 Gift Codes
    // Outstanding needs the same credit a cash sale gets via
    // eod_cash_adjustments, or every redemption of a non-cash-sold code
    // debits 2250 with nothing to offset it. Post the sale JE directly:
    // DR the method's own account (the same one resolve_cash_account()
    // would pick for an ordinary payment of this method) / CR 2250.
    const { data: methodAccount } = await admin
      .from("payment_method_account_map")
      .select("account_id")
      .eq("payment_method", parsed.data.purchase_method)
      .maybeSingle();
    const { data: outstandingAccount } = await admin
      .from("chart_of_accounts")
      .select("id")
      .eq("code", "2250")
      .single();

    const jeErr =
      methodAccount && outstandingAccount
        ? await postSimpleJournalEntry(admin, {
            postingDate: todayManilaISODate(),
            description: `Gift code ${parsed.data.code} sold (${parsed.data.purchase_method}) to ${parsed.data.buyer_name}`,
            sourceKind: "gift_code_sale",
            sourceId: code.id,
            debitAccountId: methodAccount.account_id,
            creditAccountId: outstandingAccount.id,
            amountPhp: Number(code.face_value_php),
            createdBy: session.user_id,
          })
        : "Could not find the account for this payment method. Ask an admin to check payment routing.";

    if (jeErr) {
      await undoSale();
      return { ok: false, error: jeErr };
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

/**
 * Cancel-and-refund an UNREDEEMED gift-code sale (reception or admin). Fixes
 * the gap left once the generic cash-drawer Void was correctly blocked from
 * touching a gift-code-sale row (see cash-drawer/actions.ts) — the only
 * remaining undo was Admin → Gift codes → Cancel, which is a permanent
 * terminal state (status='cancelled', see 0013's
 * `gift_codes_status_consistency`). This does all three together:
 *
 *   1. Reverse the sale's accounting — cash sale: void the matching
 *      `eod_cash_adjustments` row (its trigger posts the reversal JE);
 *      non-cash sale: reverse the direct sale JE. Mirrors
 *      `cancelGiftCodeAction`'s own two branches exactly (0139/Finding 11).
 *   2. Mark the voucher unspendable by returning it to 'generated' — NOT a
 *      new terminal status. Decision: a refunded code IS re-sellable (see
 *      0142's migration note) — the voucher itself isn't defective, the
 *      SALE was mis-keyed, and 'generated' already can't be redeemed (only
 *      'purchased' can), so this one write satisfies both "can't be spent"
 *      and "back in inventory" at once.
 *   3. Audit it.
 *
 * Order matters: step 1 runs FIRST. It's the step most likely to be
 * refused — the drawer entry is guarded by the day-close trigger (P0015),
 * so a refund attempted after EOD has closed for the sale's business date
 * fails right here, before `gift_codes` has been touched at all. Step 2 is
 * a single, tightly-scoped, optimistic-concurrency-guarded UPDATE that has
 * no trigger standing in its way — the only realistic way it fails after
 * step 1 has succeeded is a genuine race with a concurrent redemption of
 * the SAME code in the same instant, which the `.eq("status", "purchased")`
 * guard below catches (zero rows updated) instead of silently clobbering a
 * real redemption. If step 2 ever does fail there, there is no safe
 * "un-void" of step 1 to fall back on — nothing in this codebase un-voids
 * an `eod_cash_adjustments` row or un-reverses a JE, by design (void /
 * reverse are permanent corrections, not toggles) — so that residual case
 * is surfaced loudly to the user and audited as its own event rather than
 * silently left half-done.
 */
export async function refundGiftCodeSaleAction(
  _prev: RefundResult | null,
  formData: FormData,
): Promise<RefundResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = RefundGiftCodeSchema.safeParse({
    code: formData.get("code"),
    refund_reason: formData.get("refund_reason"),
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
    .select("id, status, face_value_php, purchase_method, purchased_by_name")
    .eq("code", parsed.data.code)
    .maybeSingle();
  if (!code) {
    return { ok: false, error: "No gift code found with that number." };
  }

  const eligibility = giftCodeRefundEligibility(code.status as GiftCodeStatus);
  if (!eligibility.ok) return eligibility;

  if (!code.purchase_method) {
    // Defensive: sellGiftCodeAction always sets this before flipping to
    // 'purchased'. Null here means the row is in a state this action
    // doesn't know how to reverse safely — refuse rather than guess.
    return {
      ok: false,
      error:
        "This code's sale has no recorded payment method — ask an admin to check it before refunding.",
    };
  }

  // Step 1 (see function doc: this runs FIRST). Reverse the sale's
  // accounting. Nothing on `gift_codes` has been touched yet, so a failure
  // here — e.g. P0015, EOD already closed for the sale's business date —
  // leaves everything exactly as it was.
  let noActiveAdjustmentFound = false;
  if (code.purchase_method === "cash") {
    const { data: adjustment } = await admin
      .from("eod_cash_adjustments")
      .select("id")
      .eq("gift_code_id", code.id)
      .eq("kind", "gift_code_sale")
      .is("voided_at", null)
      .maybeSingle();
    if (adjustment) {
      const { error: voidErr } = await admin
        .from("eod_cash_adjustments")
        .update({
          voided_at: new Date().toISOString(),
          voided_by: session.user_id,
          void_reason: `Gift code sale refunded: ${parsed.data.refund_reason}`,
        })
        .eq("id", adjustment.id)
        .is("voided_at", null);
      if (voidErr) {
        // e.g. P0015 — EOD already closed. Refuse; nothing mutated.
        return { ok: false, error: translatePgError(voidErr) };
      }
    } else {
      // Anomalous (a cash sale should always have an active adjustment row)
      // but not this action's data to repair silently. Proceed — there is
      // no drawer entry to reverse — and flag it in the audit row below so
      // it's discoverable.
      noActiveAdjustmentFound = true;
    }
  } else {
    const jeErr = await reverseJournalEntryBySource(admin, {
      sourceKind: "gift_code_sale",
      sourceId: code.id,
      actorId: session.user_id,
      reason: `Gift code sale refunded: ${parsed.data.refund_reason}`,
    });
    if (jeErr) {
      return { ok: false, error: jeErr };
    }
  }

  // Step 2: mark the voucher unspendable and back in inventory, guarded by
  // the same optimistic-concurrency check the sell/redeem paths use
  // (Finding 6 pattern). If this matches zero rows, the code moved out of
  // 'purchased' between the read above and here (most plausibly a
  // concurrent redemption). The accounting above has already been reversed
  // by this point with no safe way to un-reverse it, so that outcome is
  // surfaced as its own admin-attention error and audited, rather than
  // silently dropped — see the function doc.
  const { data: refunded, error: updErr } = await admin
    .from("gift_codes")
    .update({
      status: "generated",
      refunded_at: new Date().toISOString(),
      refunded_by: session.user_id,
      refund_reason: parsed.data.refund_reason,
      // Restore to the same pristine "never sold" shape sellGiftCodeAction's
      // own undoSale() puts a rolled-back sale in, so a re-sold code doesn't
      // carry stale buyer info.
      purchased_at: null,
      purchased_by_name: null,
      purchased_by_contact: null,
      purchase_method: null,
      purchase_reference_number: null,
      sold_by: null,
    })
    .eq("id", code.id)
    .eq("status", "purchased") // optimistic concurrency
    .select("id")
    .maybeSingle();

  const { ip, ua } = await ipAndAgent();

  if (updErr || !refunded) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "gift_code.refund_desync",
      resource_type: "gift_code",
      resource_id: code.id,
      metadata: {
        code: parsed.data.code,
        refund_reason: parsed.data.refund_reason,
        detail: updErr
          ? translatePgError(updErr)
          : "gift_codes update matched zero rows — status changed concurrently",
      },
      ip_address: ip,
      user_agent: ua,
    });
    return {
      ok: false,
      error:
        "The sale's payment was reversed, but this code's status could not be updated. Do not resell or redeem it — ask an admin to check it right away.",
    };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "gift_code.sale_refunded",
    resource_type: "gift_code",
    resource_id: code.id,
    metadata: {
      code: parsed.data.code,
      face_value_php: code.face_value_php,
      previous_purchase_method: code.purchase_method,
      previous_buyer_name: code.purchased_by_name,
      refund_reason: parsed.data.refund_reason,
      no_active_drawer_entry_found: noActiveAdjustmentFound,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/gift-codes/sell");
  revalidatePath("/staff/gift-codes/refund");
  revalidatePath("/staff/payments/cash-drawer");
  revalidatePath("/staff/admin/gift-codes");
  redirect(
    `/staff/gift-codes/refund?refunded=${encodeURIComponent(parsed.data.code)}`,
  );
}
