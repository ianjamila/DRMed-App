import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PageHeader } from "@/components/staff/page-header";
import {
  CHANNEL_LABELS,
  STATUS_LABELS,
  type InquiryChannel,
  type InquiryStatus,
} from "@/lib/inquiries/labels";
import { Panel } from "@/components/ui/panel";
import { NewInquirySheet } from "./new-inquiry-sheet";
import {
  ariaSortFor,
  buildListHref,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = {
  title: "Inquiries — staff",
};

export const dynamic = "force-dynamic";

type StatusFilter = InquiryStatus | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "dropped", label: "Dropped" },
  { value: "all", label: "All" },
];

const BASE_PATH = "/staff/inquiries";

// The old cap matched what reception actually needed to see at a glance —
// keep it as the default page size so bookmarks/behaviour don't change.
const PAGE_SIZE_DEFAULT = 50;

// Sortable columns for the inquiry log. `parseSort` requires this exact
// allow-list — it's a security boundary because the value reaches a
// PostgREST `.order()`; never widen it to a raw search param. "Received by"
// isn't here: the name shown is resolved by a second query against
// staff_profiles (received_by_id is a bare FK to auth.users), so there's no
// single column to order by that would match what's displayed.
const SORTABLE_COLUMNS = [
  "caller_name",
  "contact",
  "channel",
  "called_at",
  "status",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "called_at", dir: "desc" };

interface PageProps {
  searchParams: Promise<{
    status?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

async function search(
  supabase: Awaited<ReturnType<typeof createClient>>,
  status: StatusFilter,
  q: string,
  sort: SortSpec<SortColumn>,
  page: number,
  size: number,
) {
  const [from, to] = rangeFor(page, size);

  let query = supabase
    .from("inquiries")
    .select(
      "id, caller_name, contact, channel, called_at, status, notes, received_by_id, linked_appointment_id, linked_visit_id",
      { count: "exact" },
    );

  if (status !== "all") query = query.eq("status", status);

  if (q) {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    query = query.or(
      [
        `caller_name.ilike.${like}`,
        `contact.ilike.${like}`,
        `service_interest.ilike.${like}`,
      ].join(","),
    );
  }

  query = query.order(sort.key, { ascending: sort.dir === "asc" });
  // Tie-break on id — without a total order, .range() can drop or repeat
  // rows across pages once there's more than one page of inquiries.
  query = query.order("id", { ascending: true }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    console.error("inquiries query failed", error);
    return { rows: [], total: 0 };
  }
  return { rows: data ?? [], total: count ?? 0 };
}

export default async function InquiriesPage({ searchParams }: PageProps) {
  const session = await requireActiveStaff();
  // Every child page (new, edit, book) already bounces non-reception/admin —
  // the list itself was the one gap left open to every role.
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }
  const params = await searchParams;
  const status: StatusFilter = (
    ["pending", "confirmed", "dropped", "all"] as const
  ).includes(params.status as StatusFilter)
    ? (params.status as StatusFilter)
    : "pending";
  const q = params.q?.trim() ?? "";
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, PAGE_SIZE_DEFAULT);
  const page = parsePage(params.page);

  const supabase = await createClient();

  // Counts per status — drives the filter chips. Cheap (small table, indexed).
  // Independent of the search box and the pager's total: these always count
  // the whole table per status, not the current `q` filter.
  const [pending, confirmed, dropped] = await Promise.all([
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "dropped"),
  ]);
  const counts = {
    pending: pending.count ?? 0,
    confirmed: confirmed.count ?? 0,
    dropped: dropped.count ?? 0,
    all: (pending.count ?? 0) + (confirmed.count ?? 0) + (dropped.count ?? 0),
  } as const;

  const { rows, total } = await search(supabase, status, q, sort, page, size);
  const inquiries = rows;
  const totalPages = pageCount(total, size);

  // Resolve received_by names via staff_profiles (FK is to auth.users; we
  // join through staff_profiles.id).
  const receivedIds = Array.from(
    new Set(inquiries.map((r) => r.received_by_id).filter(Boolean)),
  ) as string[];
  const nameMap = new Map<string, string>();
  if (receivedIds.length > 0) {
    const { data: profiles } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", receivedIds);
    for (const p of profiles ?? []) nameMap.set(p.id, p.full_name);
  }

  // Options for the "+ New inquiry" sheet's Received by picker — same query
  // the standalone /staff/inquiries/new page runs.
  const { data: staff } = await supabase
    .from("staff_profiles")
    .select("id, full_name, role, is_active")
    .eq("is_active", true)
    .in("role", ["reception", "admin"])
    .order("full_name", { ascending: true });
  const staffOptions = (staff ?? []).map((s) => ({
    id: s.id,
    full_name: s.full_name,
  }));

  // Params at their default are omitted so page 1 with the default sort,
  // size, and status stays the bare /staff/inquiries URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    status: status === "pending" ? null : status,
    q: q || null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZE_DEFAULT ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // Any change to sort resets to page 1 — staying on page 3 of a result
    // set that just reordered is a blank screen with no explanation.
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Inquiries"
        subtitle="Phone leads, FB messages, and walk-ins that haven't booked yet. Confirm them when reception books an appointment, or drop with a reason if they decided not to push through."
        actions={
          <NewInquirySheet
            staffOptions={staffOptions}
            defaultReceivedById={session.user_id}
          />
        }
      />

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = f.value === status;
          // Changing the status filter resets to page 1, same reasoning as
          // sort — and preserves the current search/sort/size via baseParams.
          const href = buildListHref(BASE_PATH, baseParams, {
            status: f.value === "pending" ? null : f.value,
            page: null,
          });
          return (
            <Link
              key={f.value}
              href={href}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                active
                  ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-navy)]"
              }`}
            >
              {f.label} · {counts[f.value]}
            </Link>
          );
        })}
      </nav>

      <form className="mb-6 flex max-w-xl gap-2">
        {status !== "pending" ? (
          <input type="hidden" name="status" value={status} />
        ) : null}
        {/* Native GET form: any field not carried as a hidden input drops out
            of the query string on submit, so sort/size ride along here too —
            and `page` deliberately does NOT, so a search resets to page 1. */}
        {!isDefaultSort ? (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        ) : null}
        {size !== PAGE_SIZE_DEFAULT ? (
          <input type="hidden" name="size" value={String(size)} />
        ) : null}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Caller name, phone, or service interest"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <Button
          type="submit"
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Search
        </Button>
      </form>

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("caller_name", "Caller")}
              {th("contact", "Contact")}
              {th("channel", "Channel")}
              {th("called_at", "Called")}
              <PlainTh label="Received by" />
              {th("status", "Status")}
              <PlainTh label="Notes" />
              <PlainTh label="Action" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {inquiries.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {q
                    ? "No inquiries match this search."
                    : status === "pending"
                      ? "No pending inquiries — nice."
                      : "Nothing here yet."}
                </td>
              </tr>
            ) : (
              inquiries.map((r) => (
                <tr
                  key={r.id}
                  className="align-top hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                    {r.caller_name}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.contact}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {CHANNEL_LABELS[r.channel as InquiryChannel] ?? r.channel}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                    {formatCalled(r.called_at)}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.received_by_id
                      ? nameMap.get(r.received_by_id) ?? "—"
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status as InquiryStatus} />
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.notes ? (
                      <span className="line-clamp-2">{r.notes}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/inquiries/${r.id}/edit`}
                      className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <ListPagination
        page={page}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={
          page > 1
            ? buildListHref(BASE_PATH, baseParams, {
                page: page - 1 > 1 ? String(page - 1) : null,
              })
            : null
        }
        nextHref={
          page < totalPages
            ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) })
            : null
        }
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          // Changing the page size resets to page 1 — same reasoning as sort.
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === PAGE_SIZE_DEFAULT ? null : String(s),
            page: null,
          }),
        }))}
        noun="inquiry"
        plural="inquiries"
      />
    </div>
  );
}

// Allow-listed in src/lib/dates/date-render-surfaces.test.ts (tier 2 —
// "no year — current inquiries only"): this deliberately omits the year, so
// it isn't a drop-in for manilaDateTime and stays inline on purpose.
function formatCalled(iso: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function StatusBadge({ status }: { status: InquiryStatus }) {
  const cls = {
    pending: "bg-amber-100 text-amber-900",
    confirmed: "bg-emerald-100 text-emerald-900",
    dropped: "bg-zinc-100 text-zinc-700",
  }[status];
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
