import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { UNDO_EXPIRED, undoWindowStartIso, type AuditRowForUndo } from "@/lib/ui/bulk-undo";

// A generous bound for the two reads below — just enough to keep them on the
// audit_log created_at index. NOT the Undo deadline: that is a single
// decision made once, from the batch's EARLIEST row (see below), never a
// per-row filter — a per-row `created_at >=` filter here would let a batch
// near expiry come back as only its later-inserted rows, and Undo would then
// treat that subset as the whole batch (P2: expiry can silently split a
// panel).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

// The caller's OWN audit rows for one bulk call, PLUS which of the batch's
// resource ids were changed again by anyone/anything else since (P1: Undo
// overwriting a newer change). Admin client: reception cannot read audit_log
// under RLS, and the filter on actor_id is what scopes the main read to the
// caller.
export async function loadOwnBatchRows(opts: {
  actorId: string;
  batchId: string;
  resourceType: "appointment" | "test_request";
  nowMs: number;
}): Promise<
  | { ok: true; rows: AuditRowForUndo[]; alreadyUndone: boolean; changedSince: Set<string> }
  | { ok: false; error: string }
> {
  const admin = createAdminClient();
  const lookback = new Date(opts.nowMs - LOOKBACK_MS).toISOString();
  const [rows, undone] = await Promise.all([
    admin
      .from("audit_log")
      .select("resource_id, action, metadata, created_at")
      .eq("actor_id", opts.actorId)
      .eq("resource_type", opts.resourceType)
      .gte("created_at", lookback)
      .eq("metadata->>bulk_batch_id", opts.batchId)
      .order("created_at", { ascending: true })
      .limit(1000),
    admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", lookback)
      .eq("metadata->>undo_of_batch", opts.batchId),
  ]);
  if (rows.error || undone.error) return { ok: false, error: "Could not read what that bulk change did — try again." };
  const allRows = rows.data ?? [];
  if (allRows.length === 0) return { ok: false, error: UNDO_EXPIRED };

  // ONE deadline for the whole batch, from its earliest row — never a
  // per-row window filter (see LOOKBACK_MS above). Compared as instants, not
  // strings: PostgREST's read-back format ("+00:00", DB precision) differs
  // from undoWindowStartIso's JS-generated one ("Z", millisecond precision),
  // so a lexicographic string compare is not reliable here.
  const earliest = allRows[0]!.created_at;
  if (Date.parse(earliest) < Date.parse(undoWindowStartIso(opts.nowMs))) {
    return { ok: false, error: UNDO_EXPIRED };
  }

  // changedSince: for every resource this batch touched, did anyone (any
  // actor, any action — including the same actor acting outside this batch)
  // write a NEWER audit row for it that is not itself part of this batch?
  // If so, Undo must refuse that resource (whole panel, for a queue panel)
  // rather than risk reversing a change it never made. Bounded to this
  // batch's own resource ids and to created_at >= its earliest row.
  const resourceIds: string[] = [];
  const firstSeenAt = new Map<string, string>();
  for (const r of allRows) {
    if (!r.resource_id) continue;
    if (!firstSeenAt.has(r.resource_id)) {
      firstSeenAt.set(r.resource_id, r.created_at);
      resourceIds.push(r.resource_id);
    }
  }
  const changedSince = new Set<string>();
  if (resourceIds.length > 0) {
    const { data: laterRows } = await admin
      .from("audit_log")
      .select("resource_id, created_at, metadata")
      .eq("resource_type", opts.resourceType)
      .in("resource_id", resourceIds)
      .gte("created_at", earliest)
      .order("created_at", { ascending: true });
    for (const r of laterRows ?? []) {
      if (!r.resource_id) continue;
      const ownCreatedAt = firstSeenAt.get(r.resource_id);
      // Instant comparison, not string — same reason as the deadline above.
      if (!ownCreatedAt || Date.parse(r.created_at) <= Date.parse(ownCreatedAt)) continue; // this batch's own row, or earlier
      const meta = (r.metadata as Record<string, unknown> | null) ?? null;
      const belongsToThisBatch = !!meta && typeof meta === "object" && meta.bulk_batch_id === opts.batchId;
      if (!belongsToThisBatch) changedSince.add(r.resource_id);
    }
  }

  return {
    ok: true,
    rows: allRows.map((r) => ({
      resource_id: r.resource_id,
      action: r.action,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    alreadyUndone: (undone.count ?? 0) > 0,
    changedSince,
  };
}
