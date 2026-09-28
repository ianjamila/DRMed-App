"use server";

import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type MarkCopyContactedResult = { ok: true; data: null } | { ok: false; error: string };

// The audit row (result.patient_contacted) is written inside the RPC itself,
// in the same transaction as the update — see 0179's
// result_mark_copy_contacted.
export async function markCopyContactedAction(
  amendmentId: string,
): Promise<MarkCopyContactedResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "Only reception or admin can do this." };
  }
  const db = await createClient();
  const { error } = await db.rpc("result_mark_copy_contacted", {
    p_amendment_id: amendmentId,
  });
  if (error) return { ok: false as const, error: translatePgError(error) };
  revalidatePath("/staff/result-follow-ups");
  return { ok: true as const, data: null };
}
