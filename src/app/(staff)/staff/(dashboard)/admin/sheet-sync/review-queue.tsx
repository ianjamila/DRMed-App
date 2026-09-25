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
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";
import { KIND_LABEL, TAB_LABEL, resolutionSummary } from "./format";
import {
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

export async function ReviewQueue({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const supabase = await createClient();
  const kindFilter = parseKindFilter(searchParams.kind);
  const showHandled = searchParams.handled === "1";
  const page = parsePage(searchParams.page);
  const size = parsePageSize(searchParams.size);
  const [from, to] = rangeFor(page, size);

  const kinds = KIND_KEYS;
  const [openCountRows, itemsResult] = await Promise.all([
    Promise.all(
      kinds.map(async (kind) => {
        const { count } = await supabase
          .from("sheet_sync_review_items")
          .select("id", { count: "exact", head: true })
          .eq("kind", kind)
          .eq("status", "open");
        return [kind, count ?? 0] as const;
      }),
    ),
    (async () => {
      let q = supabase
        .from("sheet_sync_review_items")
        .select(
          "id, tab, item_key, kind, payload, status, resolution, resolved_by, resolved_at, first_seen_at, last_seen_at",
          { count: "exact" },
        );
      q = showHandled ? q.in("status", ["resolved", "dismissed"]) : q.eq("status", "open");
      if (kindFilter) q = q.eq("kind", kindFilter);
      return q.order("last_seen_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
    })(),
  ]);

  const openByKind = Object.fromEntries(openCountRows) as Record<ReviewKind, number>;
  const openTotal = Object.values(openByKind).reduce((a, b) => a + b, 0);

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

  // Held state for every identity-kind item on this page: batch-query
  // sheet_patient_links for every link_key their payloads name, decision =
  // 'review' only (0170's hold). Only matters for the open list — a handled
  // item is read-only regardless of any hold that formed after it resolved.
  const holdMap = new Map<string, string | null>();
  if (!showHandled) {
    const allKeys = [
      ...new Set(
        items
          .filter((i) => IDENTITY_KINDS.has(i.kind))
          .flatMap((i) => (i.payload as unknown as IdentityPayload).link_keys ?? []),
      ),
    ];
    if (allKeys.length > 0) {
      const { data: holds } = await supabase
        .from("sheet_patient_links")
        .select("link_key, hold_reason")
        .eq("decision", "review")
        .in("link_key", allKeys);
      for (const h of holds ?? []) holdMap.set(h.link_key, h.hold_reason);
    }
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

  const baseParams = { page: String(page), size: String(size) };
  const chipHref = (kind: ReviewKind | null) =>
    buildListHref(BASE_PATH, { view: "review", handled: showHandled ? "1" : null }, { kind, page: null });
  const toggleHandledHref = buildListHref(
    BASE_PATH,
    { view: "review", kind: kindFilter },
    { handled: showHandled ? null : "1", page: null },
  );

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
              <span className="ml-1 text-xs opacity-80">{openByKind[kind]}</span>
            </Link>
          ))}
        </div>
        <Link href={toggleHandledHref} className="text-sm font-semibold text-cyan-700 hover:underline">
          {showHandled ? "Show open" : "Show handled"}
        </Link>
      </div>

      {items.length === 0 ? (
        <Panel className="p-6 text-sm text-[color:var(--color-brand-text-soft)]">
          {showHandled ? "No handled review items yet." : "Nothing to review right now."}
        </Panel>
      ) : showHandled ? (
        <HandledTable items={items} resolverNames={resolverNames} />
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <ReviewItemCard key={item.id} item={item} holdMap={holdMap} />
          ))}
        </div>
      )}

      <div className="mt-3">
        <ListPagination
          page={page}
          pageCount={totalPages}
          total={total}
          size={size}
          prevHref={
            page > 1
              ? buildListHref(BASE_PATH, { ...baseParams, view: "review", kind: kindFilter, handled: showHandled ? "1" : null }, {
                  page: page - 1 > 1 ? String(page - 1) : null,
                })
              : null
          }
          nextHref={
            page < totalPages
              ? buildListHref(BASE_PATH, { ...baseParams, view: "review", kind: kindFilter, handled: showHandled ? "1" : null }, {
                  page: String(page + 1),
                })
              : null
          }
          sizeOptions={PAGE_SIZES.map((s) => ({
            size: s,
            href: buildListHref(BASE_PATH, { ...baseParams, view: "review", kind: kindFilter, handled: showHandled ? "1" : null }, {
              size: s === DEFAULT_PAGE_SIZE ? null : String(s),
              page: null,
            }),
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

function holdStateFor(payload: IdentityPayload, holdMap: Map<string, string | null>): HoldState {
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

function ReviewItemCard({ item, holdMap }: { item: ReviewItemRow; holdMap: Map<string, string | null> }) {
  if (IDENTITY_KINDS.has(item.kind)) {
    const payload = item.payload as unknown as IdentityPayload;
    const holdState = holdStateFor(payload, holdMap);
    return (
      <ItemShell kind={item.kind}>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">{payload.reason}</p>
        {payload.detail && <p className="text-xs text-[color:var(--color-brand-text-soft)]">{payload.detail}</p>}
        {payload.held_because && (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">Held because: {payload.held_because}</p>
        )}
        <EvidenceTable rows={payload.rows} />
        <IdentityItemControls itemId={item.id} candidates={payload.candidates} holdState={holdState} />
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
        <UnmappedItemControls itemId={item.id} />
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
            <tr key={item.id} className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">{KIND_LABEL[item.kind]}</td>
              <td className="px-3 py-2">{itemSummary(item)}</td>
              <td className="px-3 py-2">{resolutionSummary(item.resolution)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {item.resolved_by ? (resolverNames.get(item.resolved_by) ?? "—") : "—"}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {item.resolved_at ? manilaDateTime(item.resolved_at) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
