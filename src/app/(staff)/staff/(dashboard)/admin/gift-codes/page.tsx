import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Button } from "@/components/ui/button";
import { formatPhp } from "@/lib/marketing/format";
import {
  GIFT_CODE_STATUSES,
  STATUS_BADGE,
  STATUS_LABELS,
  type GiftCodeStatus,
} from "@/lib/gift-codes/labels";
import { Panel } from "@/components/ui/panel";
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

export const metadata = { title: "Gift codes" };

export const dynamic = "force-dynamic";

type StatusFilter = GiftCodeStatus | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "generated", label: "Generated" },
  { value: "purchased", label: "Purchased" },
  { value: "redeemed", label: "Redeemed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

const BASE_PATH = "/staff/admin/gift-codes";

// The old cap matched what admin actually needed to see at a glance — keep
// it as the default page size so bookmarks/behaviour don't change.
const PAGE_SIZE_DEFAULT = 100;

// Sortable columns for the gift-code ledger. `parseSort` requires this exact
// allow-list — it's a security boundary because the value reaches a
// PostgREST `.order()`; never widen it to a raw search param. "Last event"
// isn't here: it's `redeemed_at ?? purchased_at ?? generated_at` computed in
// JS, and there's no single column that would sort to match what's shown.
const SORTABLE_COLUMNS = [
  "code",
  "face_value_php",
  "status",
  "batch_label",
  "purchased_by_name",
  "generated_at",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "generated_at", dir: "desc" };

// Batch/buyer are nullable (a code that's only been generated has neither) —
// sink blanks to the bottom regardless of direction rather than letting them
// surface first on one of the two directions.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["batch_label", "purchased_by_name"]);

interface PageProps {
  searchParams: Promise<{
    status?: string;
    q?: string;
    batch_label?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

async function search(
  admin: ReturnType<typeof createAdminClient>,
  status: StatusFilter,
  q: string,
  batchLabel: string,
  sort: SortSpec<SortColumn>,
  page: number,
  size: number,
) {
  const [from, to] = rangeFor(page, size);

  let query = admin
    .from("gift_codes")
    .select(
      "id, code, face_value_php, status, batch_label, generated_at, purchased_at, redeemed_at, purchased_by_name",
      { count: "exact" },
    );

  if (status !== "all") query = query.eq("status", status);
  if (batchLabel) query = query.eq("batch_label", batchLabel);
  if (q) {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    query = query.or(
      [`code.ilike.${like}`, `batch_label.ilike.${like}`].join(","),
    );
  }

  query = query.order(sort.key, {
    ascending: sort.dir === "asc",
    ...(NULLS_LAST_COLUMNS.has(sort.key) ? { nullsFirst: false } : {}),
  });
  // Tie-break on id — without a total order, .range() can drop or repeat
  // rows across pages once there's more than one page of codes.
  query = query.order("id", { ascending: true }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    console.error("gift_codes query failed", error);
    return { rows: [], total: 0 };
  }
  return { rows: data ?? [], total: count ?? 0 };
}

export default async function GiftCodesAdminPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const status: StatusFilter = (
    [...GIFT_CODE_STATUSES, "all"] as ReadonlyArray<StatusFilter>
  ).includes(params.status as StatusFilter)
    ? (params.status as StatusFilter)
    : "generated";
  const q = params.q?.trim() ?? "";
  const batchLabel = params.batch_label?.trim() ?? "";
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, PAGE_SIZE_DEFAULT);
  const page = parsePage(params.page);

  const admin = createAdminClient();

  const counts = Object.fromEntries(
    await Promise.all(
      GIFT_CODE_STATUSES.map(async (s) => {
        const { count } = await admin
          .from("gift_codes")
          .select("id", { count: "exact", head: true })
          .eq("status", s);
        return [s, count ?? 0] as const;
      }),
    ),
  ) as Record<GiftCodeStatus, number>;
  const totalCount =
    counts.generated + counts.purchased + counts.redeemed + counts.cancelled;

  const { rows, total } = await search(admin, status, q, batchLabel, sort, page, size);
  const codes = rows;
  const totalPages = pageCount(total, size);

  // Params at their default are omitted so page 1 with the default sort,
  // size, and status stays the bare /staff/admin/gift-codes URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    status: status === "generated" ? null : status,
    q: q || null,
    batch_label: batchLabel || null,
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
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 11 · Admin
          </p>
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Gift codes
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Pre-issued vouchers reception sells at the counter and customers
            redeem against future visits. Codes are whole-use — applying a
            ₱500 code to a ₱300 visit forfeits the ₱200 balance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/staff/admin/gift-codes/sales"
            className="rounded-md border border-[color:var(--color-brand-navy)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Sales report
          </Link>
          <Link
            href="/staff/admin/gift-codes/generate"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            + Generate batch
          </Link>
        </div>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = f.value === status;
          // Changing the status filter resets to page 1, same reasoning as
          // sort — and preserves the current search/batch/sort/size via
          // baseParams.
          const href = buildListHref(BASE_PATH, baseParams, {
            status: f.value === "generated" ? null : f.value,
            page: null,
          });
          const count =
            f.value === "all" ? totalCount : counts[f.value];
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
              {f.label} · {count}
            </Link>
          );
        })}
      </nav>

      <form className="mb-6 flex max-w-xl gap-2">
        {status !== "generated" ? (
          <input type="hidden" name="status" value={status} />
        ) : null}
        {batchLabel ? (
          <input type="hidden" name="batch_label" value={batchLabel} />
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
          placeholder="Code or batch label"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <Button
          type="submit"
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Search
        </Button>
      </form>

      {batchLabel ? (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2 text-xs text-[color:var(--color-brand-text-mid)]">
          <span>
            Filtered to batch <strong>{batchLabel}</strong>
          </span>
          <Link
            href={buildListHref(BASE_PATH, baseParams, { batch_label: null, page: null })}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Clear
          </Link>
        </div>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("code", "Code")}
              {th("face_value_php", "Face value")}
              {th("status", "Status")}
              {th("batch_label", "Batch")}
              {th("purchased_by_name", "Buyer")}
              <PlainTh label="Last event" />
              <PlainTh label="Action" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {codes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No gift codes match.
                </td>
              </tr>
            ) : (
              codes.map((c) => (
                <tr key={c.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                    {c.code}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {formatPhp(c.face_value_php)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        STATUS_BADGE[c.status as GiftCodeStatus]
                      }`}
                    >
                      {STATUS_LABELS[c.status as GiftCodeStatus]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {c.batch_label ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {c.purchased_by_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                    {formatLastEvent(c)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/admin/gift-codes/${c.id}`}
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
        noun="code"
        plural="codes"
      />
    </div>
  );
}

interface CodeRow {
  generated_at: string;
  purchased_at: string | null;
  redeemed_at: string | null;
}

// Allow-listed in src/lib/dates/date-render-surfaces.test.ts (tier 2 —
// "2-digit year — dense code table"): deliberately denser than the house
// `manilaDate`, so it stays inline on purpose.
function formatLastEvent(c: CodeRow): string {
  const iso = c.redeemed_at ?? c.purchased_at ?? c.generated_at;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}
