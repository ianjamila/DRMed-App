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
import type { SortSpec } from "@/lib/ui/table-params";
import {
  classesForKinds,
  classifyKind,
  combinePaymentStatus,
  foldVisitGroups,
  kindPredicateForSet,
  type VisitClass,
  type VisitView,
} from "./classification";
import { archiveSearchPlan, applyArchiveSearch } from "./archive-search";
import { shouldPrintReceipt } from "./receipt-policy";
import { waivedAmount } from "./statement";
import { fetchCompleteRowsByIds } from "@/lib/reports/paging";

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
  /**
   * Whether the combined receipt still has a slip to print. False once every
   * surviving half is consultation-only (partner revisions item 1) — e.g. the
   * lab half was deleted from the queue — so the row can hide the link rather
   * than send reception to a "no receipt" page.
   */
  printsReceipt: boolean;
  members: ArchiveVisit[];
  patient: ArchiveVisit["patients"];
  visitDate: string;
  classes: VisitClass[];
  /** Billed lines only — package components are excluded (see below). */
  testCount: number;
  total: number;
  paid: number;
  /**
   * What the clinic waived, summed per member: a split visit whose halves are
   * paid + waived combines to "paid", which would otherwise hide the waiver.
   */
  waived: number;
  status: string;
  methods: string;
  deleted: boolean;
  deleteReason: string | null;
}

export interface ArchiveFilters {
  q?: string;
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

// ---------------------------------------------------------------------------
// Column sorting
// ---------------------------------------------------------------------------

/**
 * Columns the Visits archive can sort by in ONE PostgREST query. Declared
 * `as const` and passed as `parseSort`'s allow-list — the value reaches a
 * `.order()` call, so this is a security boundary, not just a UI list.
 *
 * "Tests" isn't here: that count comes from a SECOND query run after this
 * window is already fetched (package components can't be counted from the
 * `visits` row), so it can't be expressed in this `.order()` at all — the
 * page renders it with `PlainTh`.
 *
 * `patient_last_name` sorts by the embedded `patients.last_name`, which
 * needs care: supabase-js's documented `referencedTable` option does NOT do
 * this — verified empirically (local PostgREST, both directions) — it only
 * reorders the nested rows *inside* a to-many embed and leaves the parent
 * (`visits`) rows in their original order; the client's own order() doc
 * comment says as much a few lines under the overload that implies
 * otherwise. What actually reorders the parent is passing the raw
 * PostgREST embedded-path — `"patients(last_name)"` — as the column
 * string itself, with no `referencedTable` option (see `ORDER_COLUMN`
 * below). That only works because PostgREST requires an inner join to let
 * an embed drive parent ordering, and `patients!inner` is already part of
 * `VISIT_SELECT` for every query here.
 */
export const ARCHIVE_SORT_COLUMNS = [
  "visit_date",
  "visit_number",
  "total_php",
  "paid_php",
  "payment_status",
  "patient_last_name",
] as const;
export type ArchiveSortColumn = (typeof ARCHIVE_SORT_COLUMNS)[number];

/** Fallback sort — the archive's original hardcoded order, unchanged. */
export const DEFAULT_ARCHIVE_SORT: SortSpec<ArchiveSortColumn> = {
  key: "visit_date",
  dir: "desc",
};

/** The real column (or embedded path) each sort key orders by. */
const ORDER_COLUMN: Record<ArchiveSortColumn, string> = {
  visit_date: "visit_date",
  visit_number: "visit_number",
  total_php: "total_php",
  paid_php: "paid_php",
  payment_status: "payment_status",
  patient_last_name: "patients(last_name)",
};

/**
 * NOTE on `total_php` / `paid_php` / `payment_status`: these sort the raw
 * per-visit row, not the folded encounter total the row displays. A split
 * visit's two halves can therefore land in slightly different positions than
 * its combined (folded) value would predict — the same documented
 * approximation this file already accepts for the visit count and the test
 * count. Split visits are rare, so this is cosmetic drift, not a correctness
 * bug.
 */

export interface OrderStep {
  column: string;
  ascending: boolean;
}

/**
 * The full, ordered list of `.order()` calls for one sort choice — pure, so
 * it's unit-testable without a live query builder.
 *
 * `visit_date` keeps its pre-existing secondary key (`created_at`, same
 * direction) so the default sort's output is byte-for-byte what it always
 * was — bookmarked `/staff/visits` URLs with no `sort`/`dir` param see no
 * change. Every other column gets no secondary beyond the tie-break.
 *
 * The LAST step is always `id` ascending — the total-order tie-break
 * without which `.range()` can drop or repeat rows across pages whenever the
 * leading column(s) tie (two visits sharing a date, a total, a status…).
 */
export function archiveOrderPlan(sort: SortSpec<ArchiveSortColumn>): OrderStep[] {
  const ascending = sort.dir === "asc";
  const steps: OrderStep[] = [{ column: ORDER_COLUMN[sort.key], ascending }];
  if (sort.key === "visit_date") {
    steps.push({ column: "created_at", ascending });
  }
  steps.push({ column: "id", ascending: true });
  return steps;
}

function applyOrderPlan<T extends { order: (c: string, o: { ascending: boolean }) => T }>(
  q: T,
  sort: SortSpec<ArchiveSortColumn>,
): T {
  let out = q;
  for (const step of archiveOrderPlan(sort)) {
    out = out.order(step.column, { ascending: step.ascending });
  }
  return out;
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
  sort: SortSpec<ArchiveSortColumn>,
  offset: number,
  limit: number,
): Promise<{ rows: ArchiveRow[]; count: number }> {
  const { start, end, classes, view } = filters;
  const search = archiveSearchPlan(filters.q);
  const select = [VISIT_SELECT, ...search.map((term) => `${term.alias}:patients()`)].join(",");
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
        ? `${select}, test_requests!inner ( id, services!inner ( id ) )`
        : select,
      { count: "exact" },
    )
    .range(offset, offset + limit - 1);

  query = applyArchiveSearch(query, search);
  query = applyOrderPlan(query, sort);
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
    const { data: sib, error } = await fetchCompleteRowsByIds(groupIds, (ids, from, to) => {
      let siblings = supabase
        .from("visits")
        .select(select)
        .in("visit_group_id", ids);
      siblings = applyArchiveSearch(siblings, search);
      siblings = applyView(siblings, view);
      if (start) siblings = siblings.gte("visit_date", start);
      if (end) siblings = siblings.lte("visit_date", end);
      return siblings.order("id", { ascending: true }).range(from, to).returns<ArchiveVisit[]>();
    });
    if (error) throw new Error(error.message);
    siblingRows = (sib ?? []).filter((v) => !pageIds.has(v.id));
  }

  const allVisits = [...pageRows, ...siblingRows];
  const kindsByVisit = new Map<string, string[]>();
  const billedLines = new Map<string, number>();

  if (allVisits.length > 0) {
    // `parent_id is null` = the BILLED lines. Package decomposition (0040)
    // writes a priced header plus zero-priced components, so counting every
    // row made a 4-item order with one package read as 12 tests.
    const { data: lines, error } = await fetchCompleteRowsByIds(
      allVisits.map((v) => v.id),
      (ids, from, to) => supabase
        .from("test_requests")
        .select("visit_id, services ( kind )")
        .in("visit_id", ids)
        .is("deleted_at", null)
        .is("parent_id", null)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<LineRow[]>(),
    );
    if (error) throw new Error(error.message);

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
        // The group receipt page only renders live visits, so a deleted half
        // can't keep the link alive on its own.
        printsReceipt: f.members
          .filter((m) => m.deleted_at === null)
          .some((m) => shouldPrintReceipt(kindsByVisit.get(m.id) ?? [])),
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
        waived: f.members.reduce((sum, m) => sum + waivedAmount(m), 0),
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
  sort: SortSpec<ArchiveSortColumn>,
  maxRows: number,
): Promise<{ rows: ArchiveRow[]; count: number; truncated: boolean }> {
  const CHUNK = 1000;
  const out: ArchiveRow[] = [];
  let offset = 0;
  let count = 0;

  for (;;) {
    const take = Math.min(CHUNK, maxRows - offset);
    if (take <= 0) break;
    // The same `sort` on every chunk is what keeps this stable: since every
    // plan (see `archiveOrderPlan`) ends on `id`, the set is a genuine total
    // order and chunk boundaries never drop or duplicate a row — an unstable
    // sort here would do both, silently, across a 1000-row seam.
    const win = await fetchArchiveWindow(supabase, filters, sort, offset, take);
    count = win.count;
    out.push(...win.rows);
    offset += take;
    if (offset >= count) break;
  }

  return { rows: out, count, truncated: count > maxRows };
}
