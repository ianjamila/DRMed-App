/**
 * The Visits archive query, shared by the page and the CSV export.
 *
 * Both surfaces must agree on exactly what "the current filters" mean — a CSV
 * that quietly exported a different row set than the table above the button
 * would be worse than no export at all. So the filtering, the split-visit fold
 * and the per-row derivation all live here, and each caller only decides how
 * much to ask for.
 *
 * Not `server-only`: it takes a client rather than building one, which keeps
 * the module importable from both a Server Component and a Route Handler.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  classesForKinds,
  classifyKind,
  combinePaymentStatus,
  foldVisitGroups,
  kindPredicateForSet,
  type VisitClass,
  type VisitView,
} from "./classification";

type AnyClient = SupabaseClient<Database>;

/** Visit columns every query here selects. Test lines are fetched separately. */
const VISIT_SELECT = `
  id, visit_number, visit_date, created_at, visit_group_id,
  payment_status, total_php, paid_php, deleted_at, delete_reason,
  patients!inner ( id, drm_id, first_name, middle_name, last_name ),
  payments ( method, voided_at )
`;

export interface ArchiveVisit {
  id: string;
  visit_number: string;
  visit_date: string;
  created_at: string;
  visit_group_id: string | null;
  payment_status: string;
  total_php: number;
  paid_php: number;
  deleted_at: string | null;
  delete_reason: string | null;
  patients: {
    id: string;
    drm_id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
  };
  payments: { method: string | null; voided_at: string | null }[] | null;
}

type LineRow = {
  visit_id: string;
  services: { kind: string } | { kind: string }[] | null;
};

/** One rendered row: a standalone visit, or a folded split encounter. */
export interface ArchiveRow {
  key: string;
  split: boolean;
  /** Set when the row is a split encounter — links to the combined receipt. */
  groupId: string | null;
  members: ArchiveVisit[];
  patient: ArchiveVisit["patients"];
  visitDate: string;
  classes: VisitClass[];
  /** Billed lines only — package components are excluded (see below). */
  testCount: number;
  total: number;
  paid: number;
  status: string;
  methods: string;
  deleted: boolean;
  deleteReason: string | null;
}

export interface ArchiveFilters {
  start: string;
  end: string;
  classes: ReadonlySet<VisitClass>;
  view: VisitView;
}

function methodsFor(payments: ArchiveVisit["payments"]): string {
  if (!payments || payments.length === 0) return "—";
  const methods = new Set<string>();
  for (const p of payments) {
    if (p.voided_at !== null) continue;
    if (p.method) methods.add(p.method);
  }
  if (methods.size === 0) return "—";
  return Array.from(methods).join(", ");
}

function kindOf(line: LineRow): string {
  const svc = Array.isArray(line.services) ? line.services[0] : line.services;
  return svc?.kind ?? "";
}

/** Apply the deleted-view predicate. `active` is the default everywhere. */
function applyView<T extends { is: (c: string, v: null) => T; not: (c: string, o: string, v: null) => T }>(
  q: T,
  view: VisitView,
): T {
  if (view === "deleted") return q.not("deleted_at", "is", null);
  if (view === "all") return q;
  return q.is("deleted_at", null);
}

/**
 * Fetch one window of the archive, already folded into encounter rows.
 *
 * `count` is a VISIT count, not a row count — a distinct count over
 * coalesce(visit_group_id, id) isn't expressible through PostgREST. Split
 * encounters are rare, so a window holding one returns one row fewer than
 * `limit`. Callers that paginate must page on `count`, which is what keeps
 * paging stable; the shortfall is cosmetic.
 */
export async function fetchArchiveWindow(
  supabase: AnyClient,
  filters: ArchiveFilters,
  offset: number,
  limit: number,
): Promise<{ rows: ArchiveRow[]; count: number }> {
  const { start, end, classes, view } = filters;
  const predicate = kindPredicateForSet(classes);
  const filtering = predicate.mode !== "none";

  // `test_requests!inner` is a predicate only — it keeps visits that still have
  // a live line of a chosen class. Embedding it doesn't multiply visit rows
  // (PostgREST nests to-many embeds), so `count` stays a visit count. The lines
  // each row DISPLAYS come from the separate query below, so filtering by class
  // never truncates the badges or the test count.
  let query = supabase
    .from("visits")
    .select(
      filtering
        ? `${VISIT_SELECT}, test_requests!inner ( id, services!inner ( id ) )`
        : VISIT_SELECT,
      { count: "exact" },
    )
    .order("visit_date", { ascending: false })
    .order("created_at", { ascending: false })
    // Total order — without a tie-break, `range()` can drop or repeat rows
    // across pages when two visits share a date and a timestamp.
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  query = applyView(query, view);
  if (start) query = query.gte("visit_date", start);
  if (end) query = query.lte("visit_date", end);

  if (predicate.mode === "in") {
    query = query
      .is("test_requests.deleted_at", null)
      .in("test_requests.services.kind", [...predicate.kinds]);
  } else if (predicate.mode === "notIn") {
    query = query
      .is("test_requests.deleted_at", null)
      .not("test_requests.services.kind", "in", `(${predicate.kinds.join(",")})`);
  }

  const { data, count } = await query.returns<ArchiveVisit[]>();
  const pageRows = data ?? [];
  const pageIds = new Set(pageRows.map((v) => v.id));

  // Top up the other halves of any split visit in this window. Both halves are
  // needed to render the row even when the window or the chips only reached one.
  const groupIds = Array.from(
    new Set(
      pageRows.map((v) => v.visit_group_id).filter((g): g is string => g !== null),
    ),
  );

  let siblingRows: ArchiveVisit[] = [];
  if (groupIds.length > 0) {
    let siblings = supabase
      .from("visits")
      .select(VISIT_SELECT)
      .in("visit_group_id", groupIds);
    siblings = applyView(siblings, view);
    if (start) siblings = siblings.gte("visit_date", start);
    if (end) siblings = siblings.lte("visit_date", end);
    const { data: sib } = await siblings.returns<ArchiveVisit[]>();
    siblingRows = (sib ?? []).filter((v) => !pageIds.has(v.id));
  }

  const allVisits = [...pageRows, ...siblingRows];
  const kindsByVisit = new Map<string, string[]>();
  const billedLines = new Map<string, number>();

  if (allVisits.length > 0) {
    // `parent_id is null` = the BILLED lines. Package decomposition (0040)
    // writes a priced header plus zero-priced components, so counting every
    // row made a 4-item order with one package read as 12 tests.
    const { data: lines } = await supabase
      .from("test_requests")
      .select("visit_id, services ( kind )")
      .in("visit_id", allVisits.map((v) => v.id))
      .is("deleted_at", null)
      .is("parent_id", null)
      .returns<LineRow[]>();

    for (const line of lines ?? []) {
      billedLines.set(line.visit_id, (billedLines.get(line.visit_id) ?? 0) + 1);
      const bucket = kindsByVisit.get(line.visit_id);
      if (bucket) bucket.push(kindOf(line));
      else kindsByVisit.set(line.visit_id, [kindOf(line)]);
    }
  }

  /** Mirrors the SQL predicate above, for anchoring. */
  const passesClasses = (visit: ArchiveVisit): boolean => {
    if (!filtering) return true;
    return (kindsByVisit.get(visit.id) ?? []).some((k) =>
      classes.has(classifyKind(k)),
    );
  };

  const rows = foldVisitGroups(allVisits, passesClasses)
    // Render a group exactly once: on the window its anchor landed in. A group
    // straddling a window boundary would otherwise appear in both.
    .filter((f) => pageIds.has(f.anchorId))
    .map((f): ArchiveRow => {
      const kinds = f.members.flatMap((m) => kindsByVisit.get(m.id) ?? []);
      const deletedMember = f.members.find((m) => m.deleted_at !== null);
      return {
        key: f.key,
        split: f.split,
        groupId: f.split ? f.members[0]!.visit_group_id : null,
        members: f.members,
        patient: f.members[0]!.patients,
        visitDate: f.members[0]!.visit_date,
        classes: classesForKinds(kinds),
        testCount: f.members.reduce(
          (sum, m) => sum + (billedLines.get(m.id) ?? 0),
          0,
        ),
        total: f.members.reduce((sum, m) => sum + Number(m.total_php), 0),
        paid: f.members.reduce((sum, m) => sum + Number(m.paid_php), 0),
        status: combinePaymentStatus(f.members.map((m) => m.payment_status)),
        methods: methodsFor(f.members.flatMap((m) => m.payments ?? [])),
        deleted: deletedMember !== undefined,
        deleteReason: deletedMember?.delete_reason ?? null,
      };
    });

  return { rows, count: count ?? 0 };
}

/**
 * Every row matching the filters, for the CSV export.
 *
 * PostgREST hard-caps a single response at 1000 rows, so this walks the set in
 * chunks. `maxRows` is a deliberate ceiling rather than an unbounded drain; the
 * caller reports when it bites instead of silently truncating.
 */
export async function fetchArchiveAll(
  supabase: AnyClient,
  filters: ArchiveFilters,
  maxRows: number,
): Promise<{ rows: ArchiveRow[]; count: number; truncated: boolean }> {
  const CHUNK = 1000;
  const out: ArchiveRow[] = [];
  let offset = 0;
  let count = 0;

  for (;;) {
    const take = Math.min(CHUNK, maxRows - offset);
    if (take <= 0) break;
    const win = await fetchArchiveWindow(supabase, filters, offset, take);
    count = win.count;
    out.push(...win.rows);
    offset += take;
    if (offset >= count) break;
  }

  return { rows: out, count, truncated: count > maxRows };
}
