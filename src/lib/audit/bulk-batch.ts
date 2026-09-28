import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { undoWindowStartIso, type AuditRowForUndo } from "@/lib/ui/bulk-undo";

// The caller's OWN audit rows for one bulk call, inside the Undo window.
// Admin client: reception cannot read audit_log under RLS, and the filter on
// actor_id is what scopes this to the caller. The created_at bound rides
// idx_audit_log_created_at, so this stays a tiny range scan.
export async function loadOwnBatchRows(opts: {
  actorId: string;
  batchId: string;
  resourceType: "appointment" | "test_request";
  nowMs: number;
}): Promise<{ ok: true; rows: AuditRowForUndo[]; alreadyUndone: boolean } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const since = undoWindowStartIso(opts.nowMs);
  const [rows, undone] = await Promise.all([
    admin
      .from("audit_log")
      .select("resource_id, action, metadata, created_at")
      .eq("actor_id", opts.actorId)
      .eq("resource_type", opts.resourceType)
      .gte("created_at", since)
      .eq("metadata->>bulk_batch_id", opts.batchId)
      .order("created_at", { ascending: true })
      .limit(1000),
    admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("metadata->>undo_of_batch", opts.batchId),
  ]);
  if (rows.error || undone.error) return { ok: false, error: "Could not read what that bulk change did — try again." };
  return {
    ok: true,
    rows: (rows.data ?? []).map((r) => ({
      resource_id: r.resource_id,
      action: r.action,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    alreadyUndone: (undone.count ?? 0) > 0,
  };
}
