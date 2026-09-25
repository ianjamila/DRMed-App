import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { hasStatutoryDiscountLine } from "@/lib/pricing/statutory";
import {
  visibleReceiptLines,
  receiptTotals,
  toReceiptLine,
} from "@/lib/visits/receipt-totals";
import { livePayments, statementSummary } from "@/lib/visits/statement";

/**
 * Everything a visit's statement of account shows, loaded once.
 *
 * The printed page and the emailed copy both read this, so the two can never
 * disagree about a line, a payment or the balance. Runs under the caller's
 * client — the staff RLS-scoped one — never the service-role client.
 *
 * Returns null for a missing or deleted visit (0125: a deleted visit has no
 * bill). Throws when the payments read fails: a statement that silently lists
 * no payments would show the whole bill as owed.
 */
export async function fetchStatement(
  supabase: SupabaseClient<Database>,
  visitId: string,
) {
  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, hmo_provider_id, payment_status, is_sample,
        patients!inner (
          id, drm_id, first_name, middle_name, last_name, email,
          senior_pwd_id_number, deleted_at, merged_into_id
        ),
        hmo_providers ( name ),
        test_requests (
          id, deleted_at, parent_id, is_package_header,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php, kind )
        )
      `,
    )
    .eq("id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (visitErr) throw new Error(`statement: visit lookup failed: ${visitErr.message}`);
  if (!visit) return null;
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) return null;
  const hmo = Array.isArray(visit.hmo_providers) ? visit.hmo_providers[0] : visit.hmo_providers;

  const [{ data: paymentRows, error: paymentErr }, { data: statutoryRows }] = await Promise.all([
    supabase
      .from("payments")
      .select("id, amount_php, method, reference_number, received_at, voided_at")
      .eq("visit_id", visit.id)
      .order("received_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase.from("discount_types").select("code").eq("is_statutory", true),
  ]);
  if (paymentErr) {
    throw new Error(`statement: payments lookup failed: ${paymentErr.message}`);
  }

  const lines = visibleReceiptLines((visit.test_requests ?? []).map(toReceiptLine));
  const { subtotal, totalDiscount, total } = receiptTotals(lines);
  const payments = livePayments(paymentRows ?? []);
  const summary = statementSummary(total, payments, {
    hmoBilled: visit.hmo_provider_id != null,
    waived: visit.payment_status === "waived",
  });
  const hasSeniorPwdLine = hasStatutoryDiscountLine(
    lines,
    new Set((statutoryRows ?? []).map((d) => d.code)),
  );

  return {
    visit,
    patient,
    hmo: hmo ?? null,
    lines,
    subtotal,
    totalDiscount,
    total,
    payments,
    summary,
    hasSeniorPwdLine,
  };
}

export type StatementData = NonNullable<Awaited<ReturnType<typeof fetchStatement>>>;
