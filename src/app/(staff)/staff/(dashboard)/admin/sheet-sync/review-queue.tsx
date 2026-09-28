// The review queue (?view=review). Server component: reads through the
// RLS-scoped client (sheet_sync_review_items / sheet_patient_links both carry
// an "admin read" RLS policy from 0170 — requireAdminStaff() already ran in
// page.tsx, same trust boundary). Item cards are keyed on `kind`; every text
// field comes from `payload`, which run.ts/customer-plan.ts/tabs/*.ts build
// with no raw phone/email — only a last-4 digit phone tail.
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Panel } from "@/components/ui/panel";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import {
  buildListHref,
  DEFAULT_PAGE_SIZE,
  pageCount,
  parsePage,
  parsePageSize,
  rangeFor,
} from "@/lib/ui/table-params";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";
import { KIND_LABEL, TAB_LABEL, resolutionSummary, isAutoResolution, isKeptUndoneActionable } from "./format";
import {
  DeletedPatientMatchControls,
  IdentityItemControls,
  SimpleDismissControls,
  UnmappedItemControls,
  type CandidatePayload,
  type HoldState,
} from "./review-actions";

const BASE_PATH = "/staff/admin/sheet-sync";
const KIND_KEYS = Object.keys(KIND_LABEL) as ReviewKind[];
const IDENTITY_KINDS = new Set<ReviewKind>(["ambiguous_patient", "identity_conflict", "possible_existing_patient"]);
const UNDO_HOLD_REASON = "undone by an admin";

interface EvidenceRow {
  sheet_row: number;
  name_raw: string;
  dob: string | null;
  registered_on: string | null;
  phone_last4: string | null;
  link_key: string;
}

interface IdentityPayload {
  link_keys: string[];
  rows: EvidenceRow[];
  candidates: CandidatePayload[];
  reason: string;
  detail?: string;
  held_because?: string;
  /** Present only for a deleted-patient-match hold (review fix E) — the deleted patient's id, never a name. */
  deleted_patient_id?: string;
}

/** A deleted-patient-match hold's payload carries no other identity kind's — the id alone tells it apart. */
function isDeletedPatientMatch(payload: IdentityPayload): boolean {
  return typeof payload.deleted_patient_id === "string";
}

interface UnmappedPayload {
  answer: string;
  rows: number;
}

interface DateOrRowPayload {
  tab: TabKey;
  sheet_row: number;
  column?: string;
  value?: string;
  name_raw?: string;
  reason: string;
}

interface SnapshotPayload {
  tab: TabKey;
  previous: number;
  current: number;
  shrink_pct: number;
}

interface ReviewItemRow {
  id: string;
  tab: TabKey;
  item_key: string;
  kind: ReviewKind;
  payload: Record<string, unknown>;
  status: "open" | "resolved" | "dismissed";
  resolution: Record<string, unknown> | null;
  resolved_by: string | null;
  resolved_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function parseKindFilter(raw: string | undefined): ReviewKind | null {
  return (KIND_KEYS as string[]).includes(raw ?? "") ? (raw as ReviewKind) : null;
}

function phoneTail(last4: string | null): string {
  return last4 ? `••${last4}` : "—";
}

// A card's identifying phrase for its buttons' aria-labels — kind + sheet
// row, or the answer text for unmapped_source — never a name, even though
// the name is already on screen: aria-label content still shouldn't need to
// change if the visible evidence table's columns ever do.
function rowLabelFor(item: ReviewItemRow): string {
  if (IDENTITY_KINDS.has(item.kind)) {
    const payload = item.payload as unknown as IdentityPayload;
    const row = payload.rows[0]?.sheet_row;
    return row !== undefined ? `row ${row}` : KIND_LABEL[item.kind];
  }
  if (item.kind === "suspect_snapshot") {
    const payload = item.payload as unknown as SnapshotPayload;
    return `${TAB_LABEL[payload.tab]} tab`;
  }
  const payload = item.payload as unknown as DateOrRowPayload;
  return `${TAB_LABEL[payload.tab]} row ${payload.sheet_row}`;
}

/**
 * Holds (0170: `sheet_patient_links` rows with `decision = 'review'`) —
 * loaded WITHOUT any `.in("link_key", …)` filter, because a link_key is
 * `<name norm>#<dob>` (names.ts's `linkKeyOf`): putting a page's worth of
 * them in a PostgREST `.in()` list would ride verbatim in the request URL —
 * proxy/API-gateway access logs, browser history — the exact patient-data
 * disclosure the last-4-digit phone masking elsewhere on this page exists to
 * avoid. Holds are a small, decision-scoped subset of all links (review
 * round 5 review's own words: "holds are few"), so one filtered, paged read
 * with a generous ceiling is cheap and matches every other loader here.
 */
async function loadHoldMap(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ holdMap: Map<string, string | null>; failed: boolean }> {
  try {
    const { rows, truncated } = await fetchAllRows<{ link_key: string; hold_reason: string | null }>(
      (from, to) =>
        supabase
          .from("sheet_patient_links")
          .select("link_key, hold_reason")
          .eq("decision", "review")
          .order("link_key")
          .range(from, to),
      REPORT_EXPORT_MAX_ROWS,
    );
    if (truncated) throw new Error("sheet_patient_links holds loader hit its row ceiling");
    return { holdMap: new Map(rows.map((r) => [r.link_key, r.hold_reason])), failed: false };
  } catch (e) {
    console.error("sheet sync review queue: failed to load holds", e);
    return { holdMap: new Map(), failed: true };
  }
}

export async function ReviewQueue({
  searchParams,
  openByKind,
  openCountsFailed,
}: {
  searchParams: Record<string, string | undefined>;
  /** Open counts per kind — computed once in page.tsx (also needed for the nav badge) and passed down rather than re-queried here. */
  openByKind: Record<ReviewKind, number>;
  /** Kinds whose count query failed — shown as "—" instead of a possibly-wrong 0. */
  openCountsFailed: ReviewKind[];
}) {
  const supabase = await createClient();
  const kindFilter = parseKindFilter(searchParams.kind);
  const showHandled = searchParams.handled === "1";
  const page = parsePage(searchParams.page);
  const size = parsePageSize(searchParams.size);
  const [from, to] = rangeFor(page, size);

  const kinds = KIND_KEYS;
  const openTotal = Object.values(openByKind).reduce((a, b) => a + b, 0);

  let itemsQuery = supabase
    .from("sheet_sync_review_items")
    .select(
      "id, tab, item_key, kind, payload, status, resolution, resolved_by, resolved_at, first_seen_at, last_seen_at",
      { count: "exact" },
    );
  itemsQuery = showHandled ? itemsQuery.in("status", ["resolved", "dismissed"]) : itemsQuery.eq("status", "open");
  if (kindFilter) itemsQuery = itemsQuery.eq("kind", kindFilter);
  const itemsResult = await itemsQuery.order("last_seen_at", { ascending: false }).order("id", { ascending: true }).range(from, to);

  if (itemsResult.error) {
    console.error("sheet sync review queue load failed", itemsResult.error);
    return (
      <p className="text-sm text-red-600" role="alert">
        Could not load the review queue. Try refreshing the page.
      </p>
    );
  }

  const items = (itemsResult.data ?? []) as unknown as ReviewItemRow[];
  const total = itemsResult.count ?? 0;
  const totalPages = pageCount(total, size);

  // Held state for every identity-kind item on this page. Only matters for
  // the open list — a handled item is read-only regardless of any hold that
  // formed after it resolved.
  let holdMap = new Map<string, string | null>();
  let holdsFailed = false;
  if (!showHandled && items.some((i) => IDENTITY_KINDS.has(i.kind))) {
    ({ holdMap, failed: holdsFailed } = await loadHoldMap(supabase));
  }

  // Resolver names for the handled list ("who and when").
  const resolverNames = new Map<string, string>();
  if (showHandled) {
    const ids = [...new Set(items.map((i) => i.resolved_by).filter((id): id is string => !!id))];
    if (ids.length > 0) {
      const { data: staff } = await supabase.from("staff_profiles").select("id, full_name").in("id", ids);
      for (const s of staff ?? []) resolverNames.set(s.id, s.full_name);
    }
  }

  // Every link this view can produce, from one shared base so none of them
  // silently drops a dimension (page, size, kind or handled) — chip/toggle
  // links used to drop `size`.
  const currentParams = {
    view: "review",
    kind: kindFilter,
    handled: showHandled ? "1" : null,
    page: String(page),
    size: String(size),
  };
  const hrefFor = (overrides: Record<string, string | null>) => buildListHref(BASE_PATH, currentParams, overrides);
  const chipHref = (kind: ReviewKind | null) => hrefFor({ kind, page: null });
  const toggleHandledHref = hrefFor({ handled: showHandled ? null : "1", page: null });
  const page1Href = hrefFor({ page: null });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          <Link
            href={chipHref(null)}
            aria-current={kindFilter === null ? "true" : undefined}
            className={chipClass(kindFilter === null)}
          >
            All
            <span className="ml-1 text-xs opacity-80">{openTotal}</span>
          </Link>
          {kinds.map((kind) => (
            <Link
              key={kind}
              href={chipHref(kind)}
              aria-current={kindFilter === kind ? "true" : undefined}
              className={chipClass(kindFilter === kind)}
            >
              {KIND_LABEL[kind]}
              <span className="ml-1 text-xs opacity-80">
                {openCountsFailed.includes(kind) ? "—" : openByKind[kind]}
              </span>
            </Link>
          ))}
        </div>
        <Link href={toggleHandledHref} className="text-sm font-semibold text-cyan-700 hover:underline">
          {showHandled ? "Show open" : "Show handled"}
        </Link>
      </div>

      {openCountsFailed.length > 0 && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          Some kind counts could not be loaded — the chips above marked &ldquo;—&rdquo; may be missing open items.
        </p>
      )}
      {holdsFailed && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          Could not check which items are held for a decision. Showing them as held, so nothing here can be
          dismissed by mistake — refresh the page to try again.
        </p>
      )}

      {items.length === 0 ? (
        <Panel className="p-6 text-sm text-[color:var(--color-brand-text-soft)]">
          {total > 0 ? (
            <>
              This page is empty.{" "}
              <Link href={page1Href} className="font-semibold text-cyan-700 hover:underline">
                Go to page 1
              </Link>
              .
            </>
          ) : showHandled ? (
            "No handled review items yet."
          ) : (
            "Nothing to review right now."
          )}
        </Panel>
      ) : showHandled ? (
        <HandledTable items={items} resolverNames={resolverNames} />
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <ReviewItemCard key={item.id} item={item} holdMap={holdMap} holdsFailed={holdsFailed} />
          ))}
        </div>
      )}

      <div className="mt-3">
        <ListPagination
          page={page}
          pageCount={totalPages}
          total={total}
          size={size}
          prevHref={page > 1 ? hrefFor({ page: page - 1 > 1 ? String(page - 1) : null }) : null}
          nextHref={page < totalPages ? hrefFor({ page: String(page + 1) }) : null}
          sizeOptions={PAGE_SIZES.map((s) => ({
            size: s,
            href: hrefFor({ size: s === DEFAULT_PAGE_SIZE ? null : String(s), page: null }),
          }))}
          noun="item"
        />
      </div>
    </div>
  );
}

function chipClass(active: boolean): string {
  return `min-h-9 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
    active
      ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
      : "border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)]"
  }`;
}

// `holdsFailed`: the holds query itself failed to load (loadHoldMap above),
// so `holdMap` cannot be trusted — fall back to "blocked" (no Dismiss/Keep
// undone) rather than "none", the safe direction: hiding Dismiss on an item
// that turns out to be unheld costs a click; showing it on an item that
// turns out to be held risks the SQL's 22023 refusal reaching the admin.
function holdStateFor(payload: IdentityPayload, holdMap: Map<string, string | null>, holdsFailed: boolean): HoldState {
  if (holdsFailed) return "blocked";
  const heldKeys = payload.link_keys.filter((k) => holdMap.has(k));
  if (heldKeys.length === 0) return "none";
  return heldKeys.every((k) => holdMap.get(k) === UNDO_HOLD_REASON) ? "keep_undone" : "blocked";
}

function EvidenceTable({ rows }: { rows: EvidenceRow[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="pr-3 py-1">Row</th>
            <th className="pr-3 py-1">Name as typed</th>
            <th className="pr-3 py-1">DOB</th>
            <th className="pr-3 py-1">Registered</th>
            <th className="pr-3 py-1">Phone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.link_key}-${r.sheet_row}`} className="border-t border-[color:var(--color-brand-bg-mid)]">
              <td className="pr-3 py-1">{r.sheet_row}</td>
              <td className="pr-3 py-1">{r.name_raw}</td>
              <td className="pr-3 py-1">{r.dob ? manilaDate(r.dob) : "—"}</td>
              <td className="pr-3 py-1">{r.registered_on ? manilaDate(r.registered_on) : "—"}</td>
              <td className="pr-3 py-1 font-mono">{phoneTail(r.phone_last4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemShell({ kind, children }: { kind: ReviewKind; children: React.ReactNode }) {
  return (
    <Panel className="p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
        {KIND_LABEL[kind]}
      </p>
      {children}
    </Panel>
  );
}

function ReviewItemCard({
  item,
  holdMap,
  holdsFailed,
}: {
  item: ReviewItemRow;
  holdMap: Map<string, string | null>;
  holdsFailed: boolean;
}) {
  const rowLabel = rowLabelFor(item);

  if (IDENTITY_KINDS.has(item.kind)) {
    const payload = item.payload as unknown as IdentityPayload;
    if (isDeletedPatientMatch(payload)) {
      return (
        <ItemShell kind={item.kind}>
          <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
            Matches a deleted patient record
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            This row&rsquo;s name and date of birth (or phone, when there is no date of birth) match a patient record
            that was deleted. The sync will never re-create that person on its own.
          </p>
          <EvidenceTable rows={payload.rows} />
          <DeletedPatientMatchControls itemId={item.id} rowLabel={rowLabel} />
        </ItemShell>
      );
    }
    const holdState = holdStateFor(payload, holdMap, holdsFailed);
    return (
      <ItemShell kind={item.kind}>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">{payload.reason}</p>
        {payload.detail && <p className="text-xs text-[color:var(--color-brand-text-soft)]">{payload.detail}</p>}
        {payload.held_because && (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">Held because: {payload.held_because}</p>
        )}
        <EvidenceTable rows={payload.rows} />
        <IdentityItemControls itemId={item.id} candidates={payload.candidates} holdState={holdState} rowLabel={rowLabel} />
      </ItemShell>
    );
  }

  if (item.kind === "unmapped_source") {
    const payload = item.payload as unknown as UnmappedPayload;
    return (
      <ItemShell kind={item.kind}>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          &ldquo;{payload.answer}&rdquo; — {payload.rows} row{payload.rows === 1 ? "" : "s"}
        </p>
        <UnmappedItemControls itemId={item.id} answer={payload.answer} />
      </ItemShell>
    );
  }

  if (item.kind === "unparseable_date" || item.kind === "invalid_row") {
    const payload = item.payload as unknown as DateOrRowPayload;
    return (
      <ItemShell kind={item.kind}>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {TAB_LABEL[payload.tab]} · row {payload.sheet_row}
          {payload.column ? ` · ${payload.column}` : ""}
        </p>
        <p className="text-sm text-[color:var(--color-brand-text-mid)]">{payload.reason}</p>
        {payload.name_raw && (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">Name as typed: {payload.name_raw}</p>
        )}
        {payload.value !== undefined && (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">Value as typed: {payload.value || "(blank)"}</p>
        )}
        <SimpleDismissControls
          itemId={item.id}
          hint="Fix it in the sheet — the next sync picks it up."
          rowLabel={rowLabel}
        />
      </ItemShell>
    );
  }

  // suspect_snapshot
  const payload = item.payload as unknown as SnapshotPayload;
  return (
    <ItemShell kind={item.kind}>
      <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        {TAB_LABEL[payload.tab]} had {payload.previous} rows last time and {payload.current} now (−{payload.shrink_pct}%).
        The sync skipped this tab.
      </p>
      <SimpleDismissControls
        itemId={item.id}
        label="Accept the new row count"
        hint="Only if rows were deleted on purpose; otherwise check the sheet for a filter or a sort in progress."
        rowLabel={rowLabel}
      />
    </ItemShell>
  );
}

function itemSummary(item: ReviewItemRow): string {
  if (IDENTITY_KINDS.has(item.kind)) {
    const payload = item.payload as unknown as IdentityPayload;
    return payload.rows[0]?.name_raw ?? payload.reason;
  }
  if (item.kind === "unmapped_source") {
    const payload = item.payload as unknown as UnmappedPayload;
    return `"${payload.answer}"`;
  }
  if (item.kind === "suspect_snapshot") {
    const payload = item.payload as unknown as SnapshotPayload;
    return `${TAB_LABEL[payload.tab]}: ${payload.previous} → ${payload.current} rows`;
  }
  const payload = item.payload as unknown as DateOrRowPayload;
  return `${TAB_LABEL[payload.tab]} row ${payload.sheet_row}`;
}

function HandledTable({
  items,
  resolverNames,
}: {
  items: ReviewItemRow[];
  resolverNames: Map<string, string>;
}) {
  return (
    <Panel className="overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[color:var(--color-brand-bg-mid)] text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Resolution</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">When</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <HandledRows key={item.id} item={item} resolverNames={resolverNames} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * One handled item. A row kept undone also gets the open card's evidence,
 * candidates and Link / Create controls on a second line — keeping it undone
 * parked the row, it did not answer who it is (0170's sheet_review_resolve
 * accepts link / create on it). No Dismiss / Keep undone there.
 */
function HandledRows({ item, resolverNames }: { item: ReviewItemRow; resolverNames: Map<string, string> }) {
  const actionable = isKeptUndoneActionable(item);
  const payload = actionable ? (item.payload as unknown as IdentityPayload) : null;
  return (
    <>
      <tr className={actionable ? "" : "border-b border-[color:var(--color-brand-bg-mid)] last:border-0"}>
        <td className="px-3 py-2 whitespace-nowrap">{KIND_LABEL[item.kind]}</td>
        <td className="px-3 py-2">{itemSummary(item)}</td>
        <td className="px-3 py-2">{resolutionSummary(item.resolution, item.payload)}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          {isAutoResolution(item.resolution)
            ? "Automatic"
            : item.resolved_by
              ? (resolverNames.get(item.resolved_by) ?? "—")
              : "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          {item.resolved_at ? manilaDateTime(item.resolved_at) : "—"}
        </td>
      </tr>
      {payload && isDeletedPatientMatch(payload) && (
        <tr className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0">
          <td colSpan={5} className="px-3 pb-3">
            <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
              Matches a deleted patient record
            </p>
            <EvidenceTable rows={payload.rows} />
            <DeletedPatientMatchControls itemId={item.id} rowLabel={rowLabelFor(item)} />
          </td>
        </tr>
      )}
      {payload && !isDeletedPatientMatch(payload) && (
        <tr className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0">
          <td colSpan={5} className="px-3 pb-3">
            <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">{payload.reason}</p>
            {payload.held_because && (
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">Held because: {payload.held_because}</p>
            )}
            <EvidenceTable rows={payload.rows} />
            <IdentityItemControls
              itemId={item.id}
              candidates={payload.candidates}
              holdState="kept_undone"
              rowLabel={rowLabelFor(item)}
            />
          </td>
        </tr>
      )}
    </>
  );
}
