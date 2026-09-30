// Test fixture — never imported by app code. An in-memory Supabase stand-in
// for the release pipeline (releaseVisitSelection / releaseRows / the queue
// and visit-page release actions). It HONOURS eq / neq / in / is / not filters
// (dotted paths reach into embeds) and records every call, so a test that
// drops a filter from the code under test fails instead of passing vacuously.
//
// Tables: `test_requests` (select + update) and `result_test_requests`
// (select: the links read by `test_request_id`, the membership read by
// `result_id`). It ignores the select string and returns one superset shape.

export interface FakeTestRow {
  id: string;
  visitId?: string;
  status?: string;
  section?: string;
  kind?: string;
  name?: string;
  deleted?: boolean;
  isPackageHeader?: boolean;
  visitDeleted?: boolean;
  paymentStatus?: string;
  hmoProviderId?: string | null;
  patientId?: string;
  patientActive?: boolean;
  releasedAt?: string | null;
}

export type FakeRow = Required<Omit<FakeTestRow, "hmoProviderId" | "releasedAt">> & {
  hmoProviderId: string | null;
  releasedAt: string | null;
};

export interface FakeLink {
  testRequestId: string;
  resultId: string;
}

/**
 * One-shot failure injection.
 *  - "read"           next SELECT on the table errors (either result_test_requests read)
 *  - "membership"     next result_test_requests read by result_id errors
 *  - "reread"         the SECOND and later membership reads error (the post-write check)
 *  - "truncate"       next membership read silently drops the last member of every report
 *                     (count follows the shortened list — an undetectable-by-count drop)
 *  - "cap"            next membership read drops the last member of every report but its
 *                     `count` stays the true total — PostgREST row capping
 *  - "cap-reread"     same as "cap", on the SECOND and later membership reads (post-write)
 *  - "update-error"   next UPDATE on the table errors
 *  - "update-partial" next UPDATE on the table applies to the first matching row only
 */
export type FailPhase = "read" | "membership" | "reread" | "truncate" | "update-error" | "update-partial" | "cap" | "cap-reread";

export interface FakeCall {
  table: string;
  op: "select" | "update";
  select?: string;
  count?: string;
  patch?: Record<string, unknown>;
  filters: Array<{ op: "eq" | "neq" | "in" | "is" | "not"; column: string; value: unknown; not?: string }>;
}

type Err = { code: string; message: string };
const DEFAULT_ERR: Err = { code: "XX000", message: "fake failure" };

export function makeFakeReleaseDb(seed: { rows: FakeTestRow[]; links?: FakeLink[] }) {
  const rows: FakeRow[] = seed.rows.map((r) => ({
    visitId: "v1",
    status: "ready_for_release",
    section: "chemistry",
    kind: "lab_test",
    name: r.id.toUpperCase(),
    deleted: false,
    isPackageHeader: false,
    visitDeleted: false,
    paymentStatus: "paid",
    hmoProviderId: null,
    patientId: "p1",
    patientActive: true,
    releasedAt: null,
    ...r,
  }));
  const links: FakeLink[] = [...(seed.links ?? [])];
  const calls: FakeCall[] = [];
  const failures: Array<{ table: string; phase: FailPhase; error: Err }> = [];
  let membershipReads = 0;
  const hooks: { beforeRead?: (table: string, membershipRead: boolean) => void } = {};

  const failNext = (table: string, phase: FailPhase, error: Err = DEFAULT_ERR) => {
    failures.push({ table, phase, error });
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
    released_at: r.releasedAt,
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
      let selectWanted = false;
      const q: Record<string, unknown> = {};
      q.select = (s?: string, opts?: { count?: string }) => {
        selectWanted = true;
        if (call.op === "select") {
          call.select = s;
          call.count = opts?.count;
        }
        return q;
      };
      q.update = (patch: Record<string, unknown>) => {
        call.op = "update";
        call.patch = patch;
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
          return Promise.resolve(execute(call, selectWanted)).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      };
      return q;
    },
  };

  function execute(call: FakeCall, selectWanted: boolean): { data: unknown; error: Err | null; count?: number | null } {
    const { table } = call;
    if (table === "test_requests") {
      const live = rows.filter((r) => call.filters.every((f) => matches(project(r), f)));
      if (call.op === "select") {
        hooks.beforeRead?.(table, false);
        const fail = take(table, ["read"]);
        if (fail) return { data: null, error: fail.error };
        return { data: live.map(project), error: null };
      }
      const fail = take(table, ["update-error"]);
      if (fail) return { data: null, error: fail.error };
      const partial = take(table, ["update-partial"]);
      const targets = partial ? live.slice(0, 1) : live;
      for (const r of targets) {
        const p = call.patch ?? {};
        if (typeof p.status === "string") r.status = p.status;
        if (typeof p.released_at === "string" || p.released_at === null) r.releasedAt = p.released_at as string | null;
      }
      return { data: selectWanted ? targets.map(project) : null, error: null };
    }
    if (table === "result_test_requests") {
      const byResult = call.filters.some((f) => f.column === "result_id");
      hooks.beforeRead?.(table, byResult);
      const fail = take(table, ["read"]);
      if (fail) return { data: null, error: fail.error };
      let out = links.filter((l) =>
        call.filters.every((f) => {
          if (f.column === "test_request_id") return matches({ test_request_id: l.testRequestId }, f);
          if (f.column === "result_id") return matches({ result_id: l.resultId }, f);
          return true;
        }),
      );
      if (!byResult) return { data: out.map((l) => ({ test_request_id: l.testRequestId, result_id: l.resultId })), error: null };
      membershipReads += 1;
      const mFail = take(table, ["membership"]) ?? (membershipReads >= 2 ? take(table, ["reread"]) : null);
      if (mFail) return { data: null, error: mFail.error };
      const dropLast = () => {
        const lastByResult = new Map<string, FakeLink>();
        for (const l of out) lastByResult.set(l.resultId, l);
        out = out.filter((l) => lastByResult.get(l.resultId) !== l);
      };
      const inner = (l: FakeLink) => rows.some((x) => x.id === l.testRequestId);
      let trueTotal = out.filter(inner).length;
      if (take(table, ["truncate"])) {
        dropLast();
        trueTotal = out.filter(inner).length;
      } else if (take(table, ["cap"]) ?? (membershipReads >= 2 ? take(table, ["cap-reread"]) : null)) {
        dropLast();
      }
      return {
        count: call.count ? trueTotal : null,
        data: out
          .map((l) => ({ l, r: rows.find((x) => x.id === l.testRequestId) }))
          .filter((x) => x.r !== undefined)
          .map(({ l, r }) => ({ test_request_id: l.testRequestId, result_id: l.resultId, test_requests: project(r!) })),
        error: null,
      };
    }
    throw new Error(`fake db: unsupported table ${table}`);
  }

  return { client: client as never, rows, links, calls, hooks, failNext };
}
