// Loads payment rows with everything the "what happened to this payment"
// displays need: the visit (and patient) each row is filed against, who
// deleted/edited/moved it, and — the part a single-visit query misses — the
// linked rows on OTHER visits (the far side of a move). Read through the
// caller's RLS client: payments are reception/admin only (0001), so every
// other role simply gets no rows.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { crossVisitLinkIds, type HistoryPayment } from "./payment-history";

type AnyClient = SupabaseClient<Database>;

export const PAYMENT_HISTORY_SELECT =
  "id, visit_id, amount_php, method, reference_number, received_at, notes, voided_at, void_reason, corrects_payment_id, legacy_import_run_id, voided_by_staff:staff_profiles!voided_by ( full_name ), visit:visits!visit_id ( id, visit_number, patients ( first_name, last_name ) )";

interface PatientName {
  first_name: string;
  last_name: string;
}

export interface LoadedPayment extends HistoryPayment {
  reference_number: string | null;
  received_at: string;
  notes: string | null;
  legacy_import_run_id: string | null;
  voided_by_staff: { full_name: string } | { full_name: string }[] | null;
  visit:
    | { id: string; visit_number: string; patients: PatientName | PatientName[] | null }
    | { id: string; visit_number: string; patients: PatientName | PatientName[] | null }[]
    | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function visitOf(p: LoadedPayment): { id: string; visitNumber: string; patientName: string | null } | null {
  const v = one(p.visit);
  if (!v) return null;
  const pt = one(v.patients);
  return {
    id: v.id,
    visitNumber: v.visit_number,
    patientName: pt ? `${pt.last_name}, ${pt.first_name}` : null,
  };
}

export function voidedByName(p: LoadedPayment): string | null {
  return one(p.voided_by_staff)?.full_name ?? null;
}

/**
 * The rows linked to `rows` that live outside them: replacements of voided
 * rows and originals of corrected rows. Moves are the only way these land on
 * another visit, so this is usually zero or one row.
 */
export async function loadLinkedPayments(
  client: AnyClient,
  rows: readonly LoadedPayment[],
): Promise<LoadedPayment[]> {
  const { replacementsOf, originals } = crossVisitLinkIds(rows);
  if (replacementsOf.length === 0 && originals.length === 0) return [];
  const have = new Set(rows.map((r) => r.id));
  const out: LoadedPayment[] = [];
  if (replacementsOf.length > 0) {
    const { data } = await client
      .from("payments")
      .select(PAYMENT_HISTORY_SELECT)
      .in("corrects_payment_id", replacementsOf)
      .returns<LoadedPayment[]>();
    for (const r of data ?? []) if (!have.has(r.id)) out.push(r);
  }
  if (originals.length > 0) {
    const { data } = await client
      .from("payments")
      .select(PAYMENT_HISTORY_SELECT)
      .in("id", originals)
      .returns<LoadedPayment[]>();
    for (const r of data ?? []) if (!have.has(r.id)) out.push(r);
  }
  return out;
}
