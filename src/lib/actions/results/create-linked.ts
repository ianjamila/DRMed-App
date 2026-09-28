import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

// Server-only wrappers around result_create_linked (migration 0184): the
// results row and ALL its result_test_requests links, written in one
// transaction. Before this, each creation path (prepareStructured,
// finaliseConsolidatedReport, uploadResultAction's first upload) inserted the
// row, then the links, as two separate PostgREST calls — a failure between
// them left an orphan results row no resume check could find (it keys off
// the links). See supabase/migrations/0184_patient_lifecycle_locks.sql
// section (7) for the RPC's own contract (membership lock, patient lifecycle
// lock, one-patient-per-result, P0058/P0066/P0072/23514).

type Admin = ReturnType<typeof createAdminClient>;

export interface CreateLinkedResultArgs {
  actor: string;
  testRequestIds: string[];
  kind: "structured" | "uploaded";
  reportGroupId?: string | null;
  storagePath?: string | null;
  fileSizeBytes?: number | null;
  notes?: string | null;
}

/** The raw RPC call (0184 result_create_linked): the results row + every link, one transaction. */
export function callResultCreateLinked(admin: Admin, a: CreateLinkedResultArgs) {
  return withLifecycleRetry(() =>
    admin.rpc("result_create_linked", {
      p_actor: a.actor,
      p_test_request_ids: a.testRequestIds,
      p_generation_kind: a.kind,
      p_report_group_id: a.reportGroupId ?? undefined,
      p_storage_path: a.storagePath ?? undefined,
      p_file_size_bytes: a.fileSizeBytes ?? undefined,
      p_notes: a.notes ?? undefined,
    }),
  );
}

/** For a structured draft (no storage): create it, or report why not. */
export async function createLinkedResult(
  admin: Admin,
  a: CreateLinkedResultArgs,
): Promise<{ ok: true; resultId: string } | { ok: false; code: string | null; error: string }> {
  const { data, error } = await callResultCreateLinked(admin, a);
  if (error || !data) {
    return {
      ok: false,
      code: error?.code ?? null,
      error: translatePgError(error ?? { message: "Could not create the result." }),
    };
  }
  return { ok: true, resultId: data as string };
}

// ---------------------------------------------------------------------------
// P0066-race resolution (prepareStructured): result_create_linked raises
// P0066 when a concurrent caller (two tabs, a double click) already linked
// this test to a result. Whether the loser can safely continue against the
// winner's row is a pure decision, kept here so it can be unit-tested without
// a database: only a still-open structured draft (not an uploaded PDF, not
// yet finalised) is safe to pick up — anything else must surface the original
// P0066 message.
// ---------------------------------------------------------------------------
export interface RacedResultLink {
  generation_kind: string | null;
  finalised_at: string | null;
}

export function canContinueRacedStructuredDraft(link: RacedResultLink | null | undefined): boolean {
  return link != null && link.generation_kind === "structured" && link.finalised_at === null;
}
