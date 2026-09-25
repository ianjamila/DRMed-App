import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Every-member section rule for a SHARED result PDF (a chemistry combined
// report is one file linked to every test in the panel). A lab role may open
// the file only when EVERY linked test — deleted ones included, since a deleted
// member's values are still printed on it — is inside its sections; a NULL
// section is outside every list. That is the section half of
// staff_can_read_finished_result (0172), which gates ?version=N; the current
// PDF gets the same half for every status (released, finished, or still
// being reviewed), not the "every live member finished" half.
//
// `allowed` is sectionsForRole(role): null = unrestricted (admin/pathologist),
// [] = no lab access (reception — whose PDF access is a separate rule,
// canViewResultPdf's released-only branch, never this one).
//
// No members read back proves nothing, so it fails closed for a restricted role.
export function membersWithinSections(
  allowed: readonly string[] | null,
  memberSections: readonly (string | null | undefined)[],
): boolean {
  if (allowed === null) return true;
  if (memberSections.length === 0) return false;
  return memberSections.every((s) => s != null && allowed.includes(s));
}

/**
 * The sections of every test linked to this result (deleted ones included).
 * Null when the read fails — callers treat that as "cannot prove", i.e. deny.
 */
export async function resultMemberSections(
  db: SupabaseClient<Database>,
  resultId: string,
): Promise<(string | null)[] | null> {
  const { data, error } = await db
    .from("result_test_requests")
    .select("test_requests!inner ( services!inner ( section ) )")
    .eq("result_id", resultId);
  if (error || !data) return null;
  type Svc = { section: string | null };
  type Tr = { services: Svc | Svc[] | null };
  return data.map((row) => {
    const trRel = (row as { test_requests: Tr | Tr[] | null }).test_requests;
    const tr = Array.isArray(trRel) ? trRel[0] : trRel;
    const svc = tr ? (Array.isArray(tr.services) ? tr.services[0] : tr.services) : null;
    return svc?.section ?? null;
  });
}
