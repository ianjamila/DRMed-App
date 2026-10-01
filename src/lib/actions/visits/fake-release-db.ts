// Test fixture — never imported by app code. An in-memory Supabase stand-in
// for the release pipeline (releaseVisitSelection, undoReleasedRows, the queue
// and visit-page release actions).
//
//  - `from("test_requests")` serves the callers' pre-reads (select only). It
//    HONOURS eq / neq / in / is / not filters (dotted paths reach into embeds)
//    and records every call, so a test that drops a filter from the code under
//    test fails instead of passing vacuously.
//  - `from("result_test_requests")` serves `links` as { result_id, test_request_id }
//    rows (select only, same filters and failure injection).
//  - `rpc("release_visit_results" | "undo_visit_release")` is a TypeScript
//    model of migration 0198: same result shape, same refusal codes, same
//    whole-report rule (a combined report goes out whole or not at all,
//    deleted members counted). It writes the in-memory rows like the SQL does.
//    It does NOT model the payment/consent triggers — inject those with
//    `failNextRpc`.
//  - Migration 0205 moved the release / undo AUDIT ROWS into those functions.
//    The model records what the database would write in `dbAudits`, building
//    the metadata exactly as the SQL does. It is an emulation for fixtures that
//    read audit rows afterwards; supabase/tests/0205_release_audit_in_rpc_smoke.sql
//    is what proves the real keys. Tests of the TypeScript side assert the RPC's
//    `p_audit` / `p_reason` arguments (rpcCalls), not these rows. The undo's
//    viewed_count comes from the seed's `viewedCounts` (default 0).
//
//  - Migration 0214 (the release-notice outbox, PR 3): while `outboxEnabled` is
//    true (seed option, default OFF; flip it with `setOutboxEnabled`) a release
//    that releases at least one line also enqueues ONE pending `notices` row
//    covering every released id (report-mates included) and returns its id as
//    `notice_id`; an undo cancels this visit's pending / retry notices none of
//    whose tests is still released with that release (partly undone and sending
//    rows are left alone) whatever the flag says; `cancel_release_notice` is the
//    fenced cancel (pending / retry only) and `release_notices_enabled` the flag
//    read. With the flag OFF a release returns exactly {released, refused}. Every
//    call is its own transaction here, so the same-transaction merge (two calls
//    sharing one now()) is NOT modelled — supabase/tests/0214_release_notice_enqueue_smoke.sql
//    proves it. `markNoticeSending` stands in for a claimer's lease.
//
// Failure injection is one-shot: `failNext(table, "read")` errors the next
// SELECT, `failNextRpc(name, err)` errors the next call of that RPC,
// `overrideNextRpc(name, data)` makes it return `data` instead (malformed
// shapes), and `hooks.beforeRpc` runs just before the RPC plans — the place
// to stage "someone else changed it between the page read and the write".

import { sectionsForRole } from "@/lib/auth/role-sections";

export interface FakeTestRow {
  id: string;
  visitId?: string;
  status?: string;
  section?: string;
  kind?: string;
  name?: string;
  deleted?: boolean;
  isPackageHeader?: boolean;
  /** Package component → its header row (the package release reads by parent_id). */
  parentId?: string | null;
  visitDeleted?: boolean;
  paymentStatus?: string;
  hmoProviderId?: string | null;
  patientId?: string;
  patientActive?: boolean;
  releasedAt?: string | null;
  releaseMedium?: string | null;
  /** auth user id that released it (test_requests.released_by); the RPC model stamps p_actor. */
  releasedBy?: string | null;
}

export type FakeRow = Required<Omit<FakeTestRow, "hmoProviderId" | "releasedAt" | "releaseMedium" | "parentId" | "releasedBy">> & {
  releasedBy: string | null;
  parentId: string | null;
  hmoProviderId: string | null;
  releasedAt: string | null;
  releaseMedium: string | null;
};

/**
 * The released_at the release RPC model stamps on every row it releases: a
 * fixed, full-microsecond ISO string (never round-trips through a JS Date, which
 * would truncate it to milliseconds — the 10-minute Undo compares it exactly).
 */
export const FAKE_RELEASED_AT = "2026-09-30T07:00:00.123456+00:00";

export interface FakeLink {
  testRequestId: string;
  resultId: string;
}

/** One-shot failure injection on the test_requests pre-read: "read" errors the next SELECT. */
export type FailPhase = "read";

export interface FakeCall {
  table: string;
  op: "select";
  select?: string;
  filters: Array<{ op: "eq" | "neq" | "in" | "is" | "not"; column: string; value: unknown; not?: string }>;
}

type Err = { code: string; message: string };
const DEFAULT_ERR: Err = { code: "XX000", message: "fake failure" };

export interface FakeRpcCall {
  name: string;
  args: Record<string, unknown>;
}

/** A row the database function writes to audit_log (0205), as the fake models it. */
export interface FakeDbAudit {
  actor_id: unknown;
  actor_type: "staff";
  action: "test_request.released" | "test_request.release_undone";
  resource_type: "test_request";
  resource_id: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
}

/** A release_notices row as the fake models it (the fields 0214's release / undo / cancel touch). */
export interface FakeNotice {
  id: string;
  visit_id: string;
  released_at: string;
  test_request_ids: string[];
  release_medium: string;
  bulk_batch_id: string | null;
  status: "pending" | "sending" | "retry" | "sent" | "skipped" | "suppressed" | "cancelled" | "abandoned";
  next_attempt_at: string;
  lease_token: string | null;
  resolved_at: string | null;
  audited_at: string | null;
  skip_reason: string | null;
}

export function makeFakeReleaseDb(seed: {
  /** Start with the release-notice outbox flag ON (0214; default OFF, like prod). */
  outboxEnabled?: boolean;
  rows: FakeTestRow[];
  links?: FakeLink[];
  actorRole?: string | (() => string);
  /** Result-view counts the modelled undo snapshots into viewed_count (default 0). */
  viewedCounts?: Record<string, number>;
  /** staff_profiles rows (id → full_name) served by from("staff_profiles") — the raced-release name lookup. */
  staff?: Record<string, string>;
}) {
  const rows: FakeRow[] = seed.rows.map((r) => ({
    visitId: "v1",
    status: "ready_for_release",
    section: "chemistry",
    kind: "lab_test",
    name: r.id.toUpperCase(),
    deleted: false,
    isPackageHeader: false,
    parentId: null,
    visitDeleted: false,
    paymentStatus: "paid",
    hmoProviderId: null,
    patientId: "p1",
    patientActive: true,
    releasedAt: null,
    releaseMedium: null,
    releasedBy: null,
    ...r,
  }));
  const links: FakeLink[] = [...(seed.links ?? [])];
  const calls: FakeCall[] = [];
  const failures: Array<{ table: string; phase: FailPhase; error: Err }> = [];
  const rpcCalls: FakeRpcCall[] = [];
  const dbAudits: FakeDbAudit[] = [];
  const notices: FakeNotice[] = [];
  let outboxEnabled = seed.outboxEnabled ?? false;
  let noticeSeq = 0;
  const auditParts = (args: Record<string, unknown>) => {
    const a = (args.p_audit ?? {}) as { metadata?: Record<string, unknown>; ip?: string | null; user_agent?: string | null };
    return { extras: a.metadata ?? {}, ip: a.ip ?? null, ua: a.user_agent ?? null };
  };
  const rpcFailures: Array<{ name: string; error: Err }> = [];
  const rpcOverrides: Array<{ name: string; data: unknown }> = [];
  const hooks: { beforeRead?: (table: string) => void; beforeRpc?: (name: string) => void } = {};
  const roleOfActor = () => (typeof seed.actorRole === "function" ? seed.actorRole() : (seed.actorRole ?? "medtech"));

  const failNext = (table: string, phase: FailPhase, error: Err = DEFAULT_ERR) => {
    failures.push({ table, phase, error });
  };
  const failNextRpc = (name: string, error: Err = DEFAULT_ERR) => {
    rpcFailures.push({ name, error });
  };
  const overrideNextRpc = (name: string, data: unknown) => {
    rpcOverrides.push({ name, data });
  };
  const take = (table: string, phases: FailPhase[]) => {
    const i = failures.findIndex((f) => f.table === table && phases.includes(f.phase));
    return i === -1 ? null : failures.splice(i, 1)[0];
  };

  const project = (r: FakeRow) => ({
    id: r.id,
    visit_id: r.visitId,
    status: r.status,
    deleted_at: r.deleted ? "2026-01-01T00:00:00Z" : null,
    is_package_header: r.isPackageHeader,
    parent_id: r.parentId,
    released_at: r.releasedAt,
    release_medium: r.releaseMedium,
    released_by: r.releasedBy,
    services: { section: r.section, kind: r.kind, name: r.name },
    visits: {
      deleted_at: r.visitDeleted ? "2026-01-01T00:00:00Z" : null,
      payment_status: r.paymentStatus,
      hmo_provider_id: r.hmoProviderId,
      patient_id: r.patientId,
      patients: { deleted_at: r.patientActive ? null : "2026-01-01T00:00:00Z", merged_into_id: null },
    },
  });

  const get = (obj: unknown, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
  const parseList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : String(v).replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/"/g, "").trim());

  const matches = (obj: unknown, f: FakeCall["filters"][number]): boolean => {
    const v = get(obj, f.column);
    switch (f.op) {
      case "eq": return v === f.value;
      case "neq": return v !== f.value;
      case "in": return parseList(f.value).includes(String(v));
      case "is": return f.value === null ? v === null || v === undefined : v === f.value;
      case "not":
        if (f.not === "in") return !parseList(f.value).includes(String(v));
        if (f.not === "is") return f.value === null ? !(v === null || v === undefined) : v !== f.value;
        if (f.not === "eq") return v !== f.value;
        throw new Error(`fake db: unsupported not.${f.not}`);
    }
  };

  const client = {
    from(table: string) {
      const call: FakeCall = { table, op: "select", filters: [] };
      const q: Record<string, unknown> = {};
      q.select = (s?: string) => {
        call.select = s;
        return q;
      };
      q.eq = (column: string, value: unknown) => (call.filters.push({ op: "eq", column, value }), q);
      q.neq = (column: string, value: unknown) => (call.filters.push({ op: "neq", column, value }), q);
      q.in = (column: string, value: unknown) => (call.filters.push({ op: "in", column, value }), q);
      q.is = (column: string, value: unknown) => (call.filters.push({ op: "is", column, value }), q);
      q.not = (column: string, not: string, value: unknown) => (call.filters.push({ op: "not", column, value, not }), q);
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          calls.push(call);
          return Promise.resolve(execute(call)).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      };
      return q;
    },
  };

  function execute(call: FakeCall): { data: unknown; error: Err | null } {
    if (call.table === "staff_profiles") {
      hooks.beforeRead?.(call.table);
      const fail = take(call.table, ["read"]);
      if (fail) return { data: null, error: fail.error };
      const all = Object.entries(seed.staff ?? {}).map(([id, full_name]) => ({ id, full_name }));
      return { data: all.filter((p) => call.filters.every((f) => matches(p, f))), error: null };
    }
    if (call.table === "result_test_requests") {
      hooks.beforeRead?.(call.table);
      const fail = take(call.table, ["read"]);
      if (fail) return { data: null, error: fail.error };
      const all = links.map((l) => ({ result_id: l.resultId, test_request_id: l.testRequestId }));
      return { data: all.filter((l) => call.filters.every((f) => matches(l, f))), error: null };
    }
    if (call.table !== "test_requests") throw new Error(`fake db: unsupported table ${call.table}`);
    hooks.beforeRead?.(call.table);
    const fail = take(call.table, ["read"]);
    if (fail) return { data: null, error: fail.error };
    const live = rows.filter((r) => call.filters.every((f) => matches(project(r), f)));
    return { data: live.map(project), error: null };
  }

  // ---- 0198 model ---------------------------------------------------------
  const inSections = (r: FakeRow) => {
    const sections = sectionsForRole(roleOfActor() as never);
    return sections === null || sections.includes(r.section as never);
  };
  const isDoctor = (r: FakeRow) => r.kind === "doctor_consultation" || r.kind === "doctor_procedure";
  const membersOf = (resultId: string) =>
    links.filter((l) => l.resultId === resultId).flatMap((l) => rows.filter((r) => r.id === l.testRequestId));
  const reportsOf = (ids: string[]) =>
    Array.from(new Set(links.filter((l) => ids.includes(l.testRequestId)).map((l) => l.resultId))).sort();
  const p0081 = (message: string): Err => ({ code: "P0081", message });

  function lockAndAssert(visitId: string, ids: string[], deletedMessage: string): Err | null {
    // Visit/patient state is read off the selected rows (a real visit has one state; fixtures may mix).
    const visitRows = rows.filter((r) => r.visitId === visitId && (ids.length === 0 || ids.includes(r.id)));
    if (visitRows.length === 0) return p0081("Visit not found.");
    if (visitRows.some((r) => !r.patientActive)) return { code: "P0058", message: "patient is deleted or merged" };
    if (visitRows.some((r) => r.visitDeleted)) return p0081(deletedMessage);
    if (ids.length === 0) return p0081("Nothing was selected.");
    return null;
  }

  function releaseVisitResults(args: Record<string, unknown>): { data: unknown; error: Err | null } {
    const visitId = args.p_visit_id as string;
    const ids = Array.from(new Set(args.p_test_request_ids as string[])).sort();
    const err = lockAndAssert(visitId, ids, "This visit was deleted from the queue. Restore it before releasing results.");
    if (err) return { data: null, error: err };
    const refused: Array<{ id: string; code: string; report_id: string | null; count: number }> = [];
    const combined = new Set<string>();
    const okReports = new Map<string, string>(); // member id -> report id
    const release = new Set<string>();
    for (const rid of reportsOf(ids)) {
      const mem = membersOf(rid);
      if (mem.length <= 1) continue;
      mem.forEach((m) => combined.add(m.id));
      const unfinished = mem.filter((m) => !m.deleted && !["ready_for_release", "released"].includes(m.status)).length;
      const code = mem.some((m) => !inSections(m)) ? "report_outside_sections"
        : mem.some((m) => m.isPackageHeader) ? "report_package_header"
        : mem.some((m) => m.visitId !== visitId) ? "report_other_visit"
        : mem.some(isDoctor) ? "report_doctor_member"
        : mem.some((m) => m.deleted && m.status !== "released") ? "report_deleted_member"
        : unfinished > 0 ? "report_not_finished"
        : null;
      if (code) {
        for (const m of mem.filter((x) => ids.includes(x.id))) {
          refused.push({ id: m.id, code, report_id: rid, count: unfinished });
        }
      } else {
        for (const m of mem) {
          okReports.set(m.id, rid);
          if (!m.deleted && m.status === "ready_for_release") release.add(m.id);
        }
      }
    }
    for (const id of ids.filter((x) => !combined.has(x))) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.visitId !== visitId || r.deleted || r.isPackageHeader || isDoctor(r) || r.status !== "ready_for_release") continue;
      if (!inSections(r)) refused.push({ id, code: "outside_sections", report_id: null, count: 0 });
      else release.add(id);
    }
    const released = Array.from(release).sort().map((id) => {
      const r = rows.find((x) => x.id === id)!;
      r.status = "released";
      r.releasedAt = FAKE_RELEASED_AT;
      r.releasedBy = args.p_actor as string;
      r.releaseMedium = args.p_medium as string;
      return { id, name: r.name, report_id: okReports.get(id) ?? null, selected: ids.includes(id), released_at: FAKE_RELEASED_AT };
    });
    const { extras, ip, ua } = auditParts(args);
    for (const rel of released) {
      dbAudits.push({
        actor_id: args.p_actor,
        actor_type: "staff",
        action: "test_request.released",
        resource_type: "test_request",
        resource_id: rel.id,
        metadata: {
          bulk: true,
          selection: true,
          ...extras,
          visit_id: visitId,
          release_medium: args.p_medium,
          released_at: rel.released_at,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
    for (const id of ids) {
      if (!release.has(id) && !refused.some((x) => x.id === id)) {
        refused.push({ id, code: "not_ready", report_id: null, count: 0 });
      }
    }
    let noticeId: string | null = null;
    if (outboxEnabled && released.length > 0) {
      const batch = extras.bulk_batch_id;
      const notice: FakeNotice = {
        id: `notice-${++noticeSeq}`,
        visit_id: visitId,
        released_at: FAKE_RELEASED_AT,
        test_request_ids: released.map((r) => r.id),
        release_medium: args.p_medium as string,
        bulk_batch_id: batch == null || batch === "" ? null : String(batch).slice(0, 100),
        status: "pending",
        next_attempt_at: FAKE_RELEASED_AT,
        lease_token: null,
        resolved_at: null,
        audited_at: null,
        skip_reason: null,
      };
      notices.push(notice);
      noticeId = notice.id;
    }
    return { data: { released, refused, ...(noticeId ? { notice_id: noticeId } : {}) }, error: null };
  }

  function undoVisitRelease(args: Record<string, unknown>): { data: unknown; error: Err | null } {
    const visitId = args.p_visit_id as string;
    const ids = Array.from(new Set(args.p_test_request_ids as string[])).sort();
    const err = lockAndAssert(visitId, ids, "This visit was deleted from the queue. Restore it before undoing a release.");
    if (err) return { data: null, error: err };
    const expected = args.p_expected_released_at as Record<string, string> | null | undefined;
    const batch = expected != null;
    const refusedIds = new Set<string>();
    const expanded = new Set(ids);
    const okReports = new Map<string, string>();
    for (const rid of reportsOf(ids)) {
      const mem = membersOf(rid);
      if (mem.length <= 1) continue;
      if (mem.some((m) => !inSections(m))) return { data: null, error: p0081("This report has tests outside the sections you can act on, so it can't be undone from here — ask an admin.") };
      if (mem.some((m) => m.isPackageHeader)) return { data: null, error: p0081("This report includes a package header, which shouldn't happen — ask an admin to check it.") };
      if (mem.some((m) => m.visitId !== visitId)) return { data: null, error: p0081("This report spans more than one visit, which shouldn't happen — ask an admin to check it.") };
      // Batch Undo: the report comes back only if EVERY member (deleted ones included) is still exactly this batch's release.
      if (batch && mem.some((m) => !(m.id in expected) || m.status !== "released" || m.deleted || m.releasedAt !== expected[m.id])) {
        mem.forEach((m) => refusedIds.add(m.id));
        continue;
      }
      for (const m of mem) {
        expanded.add(m.id);
        okReports.set(m.id, rid);
      }
    }
    const cands = rows.filter(
      (r) => expanded.has(r.id) && r.visitId === visitId && r.status === "released" && !r.isPackageHeader && !r.deleted && inSections(r)
        && !refusedIds.has(r.id) && (!batch || (r.id in expected && r.releasedAt === expected[r.id])),
    );
    if (cands.length === 0 && !batch) return { data: null, error: p0081("None of the selected tests can be unreleased.") };
    const { extras, ip, ua } = auditParts(args);
    const undone = cands
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const prior = { id: r.id, prior_release_medium: r.releaseMedium, prior_released_at: r.releasedAt, report_id: okReports.get(r.id) ?? null };
        dbAudits.push({
          actor_id: args.p_actor,
          actor_type: "staff",
          action: "test_request.release_undone",
          resource_type: "test_request",
          resource_id: r.id,
          metadata: {
            ...extras,
            visit_id: visitId,
            reason: args.p_reason,
            prior_release_medium: r.releaseMedium,
            prior_released_at: r.releasedAt,
            viewed_count: seed.viewedCounts?.[r.id] ?? 0,
            report_result_id: prior.report_id,
          },
          ip_address: ip,
          user_agent: ua,
        });
        r.status = "ready_for_release";
        r.releasedAt = null;
        r.releasedBy = null;
        r.releaseMedium = null;
        return prior;
      });
    // 0214: cancel this visit's pending / retry notices with nothing left released under their release.
    for (const n of notices) {
      if (n.visit_id !== visitId || (n.status !== "pending" && n.status !== "retry")) continue;
      const stillReleased = n.test_request_ids.some((id) => {
        const r = rows.find((x) => x.id === id);
        return r !== undefined && r.status === "released" && r.releasedAt === n.released_at;
      });
      if (stillReleased) continue;
      n.status = "cancelled";
      n.resolved_at = FAKE_RELEASED_AT;
      n.audited_at = FAKE_RELEASED_AT;
      n.lease_token = null;
      n.skip_reason = "release undone";
    }
    const undoneIds = new Set(undone.map((u) => u.id));
    const skipped = ids.filter((id) => !undoneIds.has(id)).map((id) => ({ id, code: batch ? "changed_since" : "not_released" }));
    return { data: { undone, skipped }, error: null };
  }

  // The fenced cancel (0214): pending / retry only; false for a sending / terminal / unknown row.
  function cancelReleaseNotice(args: Record<string, unknown>): { data: unknown; error: Err | null } {
    const n = notices.find((x) => x.id === args.p_id);
    if (!n || (n.status !== "pending" && n.status !== "retry")) return { data: false, error: null };
    n.status = "cancelled";
    n.resolved_at = FAKE_RELEASED_AT;
    n.audited_at = FAKE_RELEASED_AT;
    n.lease_token = null;
    n.skip_reason = typeof args.p_reason === "string" ? args.p_reason.slice(0, 200) : n.skip_reason;
    return { data: true, error: null };
  }

  const models: Record<string, (args: Record<string, unknown>) => { data: unknown; error: Err | null }> = {
    release_visit_results: releaseVisitResults,
    undo_visit_release: undoVisitRelease,
    cancel_release_notice: cancelReleaseNotice,
    release_notices_enabled: () => ({ data: outboxEnabled, error: null }),
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    hooks.beforeRpc?.(name);
    const fi = rpcFailures.findIndex((f) => f.name === name);
    if (fi !== -1) return { data: null, error: rpcFailures.splice(fi, 1)[0].error };
    const oi = rpcOverrides.findIndex((o) => o.name === name);
    if (oi !== -1) return { data: rpcOverrides.splice(oi, 1)[0].data, error: null };
    const model = models[name];
    if (!model) throw new Error(`fake db: unsupported rpc ${name}`);
    return model(args);
  };

  const setOutboxEnabled = (on: boolean) => {
    outboxEnabled = on;
  };
  /** A claimer leased the notice (status sending): undo and cancel must leave it alone. */
  const markNoticeSending = (id: string) => {
    const n = notices.find((x) => x.id === id);
    if (!n) throw new Error(`fake db: no notice ${id}`);
    n.status = "sending";
    n.lease_token = `lease-${id}`;
  };

  return {
    client: { ...client, rpc } as never,
    rows, links, calls, rpcCalls, dbAudits, notices, hooks,
    failNext, failNextRpc, overrideNextRpc, setOutboxEnabled, markNoticeSending,
  };
}
