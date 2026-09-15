import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Panel } from "@/components/ui/panel";
import { manilaDateTime } from "@/lib/dates/manila";
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
import { SortableTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = { title: "Newsletter — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    sent?: string;
    delivered?: string;
    failed?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
    filter?: string;
  }>;
}

const BASE_PATH = "/staff/admin/newsletter";

// Sortable columns on the subscriber list. `parseSort` requires this exact
// allow-list — the value reaches a PostgREST `.order()`, so it is a security
// boundary. Status sorts by `unsubscribed_at`, the column behind the badge,
// and deliberately does NOT force nulls last: Postgres puts nulls last on ASC
// and first on DESC, which is exactly what makes both directions useful here
// (active subscribers first, or the people who left first).
const SORTABLE_COLUMNS = ["email", "source", "consent_at", "unsubscribed_at"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "consent_at", dir: "desc" };

/** This list has always shown 50 subscribers; the picker can change it. */
const DEFAULT_SIZE = 50;

/**
 * How many campaigns "Recent campaigns" shows. Kept as a window rather than a
 * pager — a clinic sends a handful of these a year — but the count beside the
 * heading is exact, so a reader can see when there are older ones it isn't
 * showing, instead of a bare `.limit()` that says nothing.
 */
const CAMPAIGN_WINDOW = 20;

export default async function NewsletterAdminPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const admin = createAdminClient();

  const filter: "active" | "unsubscribed" | "all" =
    params.filter === "unsubscribed" || params.filter === "all"
      ? params.filter
      : "active";
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, DEFAULT_SIZE);
  const page = parsePage(params.page);
  const [from, to] = rangeFor(page, size);

  let subsQuery = admin
    .from("subscribers")
    .select(
      "id, email, source, consent_at, unsubscribed_at, unsubscribe_token",
      { count: "exact" },
    )
    .order(sort.key, { ascending: sort.dir === "asc" })
    // Tie-break on id — subscribers share a `source`, and an import lands
    // many in the same second; without a total order `.range()` drops or
    // repeats rows between pages.
    .order("id", { ascending: true })
    .range(from, to);
  if (filter === "active") subsQuery = subsQuery.is("unsubscribed_at", null);
  if (filter === "unsubscribed")
    subsQuery = subsQuery.not("unsubscribed_at", "is", null);

  const [
    { count: activeCount },
    { count: totalCount },
    campaignsRes,
    subsRes,
  ] = await Promise.all([
    admin
      .from("subscribers")
      .select("id", { count: "exact", head: true })
      .is("unsubscribed_at", null),
    admin.from("subscribers").select("id", { count: "exact", head: true }),
    admin
      .from("newsletter_campaigns")
      .select("id, subject, sent_at, recipient_count", { count: "exact" })
      .order("sent_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(CAMPAIGN_WINDOW),
    subsQuery,
  ]);

  const campaigns = campaignsRes.data ?? [];
  const campaignTotal = campaignsRes.count ?? campaigns.length;
  const subscribers = subsRes.data ?? [];
  const filteredCount = subsRes.count ?? 0;
  const totalPages = pageCount(filteredCount, size);

  // Params at their default are omitted, so the bare /staff/admin/newsletter
  // URL stays the one people bookmark.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    filter: filter === "active" ? null : filter,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_SIZE ? null : String(size),
  };

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    // A re-sort goes back to page 1 — page 4 of a set that just reordered is
    // a screenful of unrelated rows.
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
            Phase 14 · Admin
          </p>
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Newsletter
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Compose and send updates to people who opted in via the
            marketing site. Patient transactional emails are separate.
          </p>
        </div>
        <Link
          href="/staff/admin/newsletter/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New campaign
        </Link>
      </header>

      {params.sent ? (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Campaign sent.</p>
          <p className="mt-1">
            Delivered to {params.delivered ?? "?"} subscriber
            {params.delivered === "1" ? "" : "s"}
            {params.failed && Number(params.failed) > 0
              ? ` · ${params.failed} failed`
              : ""}
            .
          </p>
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <Stat label="Active subscribers" value={activeCount ?? 0} />
        <Stat
          label="Total ever (incl. unsubscribed)"
          value={totalCount ?? 0}
        />
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Subscribers ({filteredCount})
          </h2>
          <nav className="flex gap-2">
            {(["active", "unsubscribed", "all"] as const).map((f) => {
              const active = filter === f;
              return (
                <Link
                  key={f}
                  // Switching scope keeps the sort and page size — all three
                  // views are the same columns over a narrower set — but goes
                  // back to page 1, since the set changes shape.
                  href={buildListHref(BASE_PATH, baseParams, {
                    filter: f === "active" ? null : f,
                    page: null,
                  })}
                  className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                    active
                      ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
                      : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)]"
                  }`}
                >
                  {f === "active"
                    ? "Active"
                    : f === "unsubscribed"
                      ? "Unsubscribed"
                      : "All"}
                </Link>
              );
            })}
          </nav>
        </div>
        {subscribers.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-6 text-sm text-[color:var(--color-brand-text-soft)]">
            No subscribers in this view.
          </p>
        ) : (
          <Panel className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  {th("email", "Email")}
                  {th("source", "Source")}
                  {th("consent_at", "Subscribed")}
                  {th("unsubscribed_at", "Status")}
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {subscribers.map((s) => {
                  const isActive = s.unsubscribed_at === null;
                  return (
                    <tr key={s.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                        {s.email}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {sourceLabel(s.source)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                        {manilaDateTime(s.consent_at)}
                      </td>
                      <td className="px-4 py-3">
                        {isActive ? (
                          <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700">
                            Unsubscribed
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )}
        {/* "Newer / Older" was only right while the sort was fixed to
            newest-first; a column header can reverse it now, so the pager
            reads Previous / Next like every other list page. Gated on the
            COUNT rather than on the rows on screen — someone who lands on
            page 5 of a one-page set still needs a way back. */}
        {filteredCount > 0 ? (
          <ListPagination
            page={page}
            pageCount={totalPages}
            total={filteredCount}
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
            sizeOptions={PAGE_SIZES.map((n) => ({
              size: n,
              // Resizing resets to page 1 — same reasoning as a re-sort.
              href: buildListHref(BASE_PATH, baseParams, {
                size: n === DEFAULT_SIZE ? null : String(n),
                page: null,
              }),
            }))}
            noun="subscriber"
          />
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Recent campaigns
          {campaignTotal > CAMPAIGN_WINDOW ? (
            <span className="ml-2 font-sans text-xs font-semibold normal-case tracking-normal text-[color:var(--color-brand-text-soft)]">
              latest {CAMPAIGN_WINDOW} of {campaignTotal}
            </span>
          ) : null}
        </h2>
        {campaigns.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-6 text-sm text-[color:var(--color-brand-text-soft)]">
            No campaigns sent yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            {campaigns.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                    {c.subject}
                  </p>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {c.sent_at ? manilaDateTime(c.sent_at) : "Draft"}
                    {c.recipient_count != null
                      ? ` · ${c.recipient_count} recipients`
                      : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case "homepage_footer":
      return "Homepage footer";
    case "newsletter_page":
      return "/newsletter";
    case "schedule_form":
      return "Booking form";
    case "admin_added":
      return "Admin-added";
    default:
      return source;
  }
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Panel className="px-4 py-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-1 text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
    </Panel>
  );
}
