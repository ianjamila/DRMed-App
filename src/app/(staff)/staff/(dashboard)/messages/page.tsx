import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { sectionTabsNavClass, sectionTabClass } from "@/components/staff/section-tabs-style";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  parsePage,
  parsePageSize,
  parseSort,
  pageCount,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { manilaDateTime } from "@/lib/dates/manila";
import { patientSearchOrClauses } from "@/lib/patients/search";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { CONTACT_MESSAGE_STATUS_LABEL, contactMessageStatusLabel } from "@/lib/contact-messages/labels";
import { attributionCampaignLabel } from "@/lib/appointments/source";
import type { Attribution } from "@/lib/analytics/attribution";
import { messagePreview } from "@/lib/contact-messages/preview";

export const metadata = {
  title: ROUTE_NAME["/staff/messages"],
};

const BASE_PATH = "/staff/messages";

type StatusTab = "new" | "replied" | "booked" | "closed" | "all";

const STATUS_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
  { value: "new", label: CONTACT_MESSAGE_STATUS_LABEL.new },
  { value: "replied", label: CONTACT_MESSAGE_STATUS_LABEL.replied },
  { value: "booked", label: CONTACT_MESSAGE_STATUS_LABEL.booked },
  { value: "closed", label: CONTACT_MESSAGE_STATUS_LABEL.closed },
  { value: "all", label: "All" },
];

const STATUS_STYLE: Record<string, string> = {
  new: "bg-sky-100 text-sky-900",
  replied: "bg-amber-100 text-amber-900",
  booked: "bg-emerald-100 text-emerald-900",
  closed: "bg-slate-200 text-slate-700",
};

// Plain-words empty state per tab — shown only when no search/kind filter is
// narrowing the view (a filtered empty result gets a generic message instead,
// so reception doesn't read "No new messages" as "nothing ever came in").
const EMPTY_LABEL: Record<StatusTab, string> = {
  new: "No new messages right now — nice and clear.",
  replied: "No messages waiting on a reply.",
  booked: "No messages have led to a booking yet.",
  closed: "No closed messages.",
  all: "No website messages yet.",
};

const SORTABLE_COLUMNS = ["created_at", "name", "status"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];
const DEFAULT_SORT: SortSpec<SortColumn> = { key: "created_at", dir: "desc" };

interface MessageRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  subject: string | null;
  message: string;
  status: string;
  kind: string;
  created_at: string;
  attribution: unknown;
}

interface SearchProps {
  searchParams: Promise<{
    status?: string;
    kind?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function MessagesPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const sp = await searchParams;
  const status: StatusTab = STATUS_TABS.some((t) => t.value === sp.status)
    ? (sp.status as StatusTab)
    : "new";
  const corporateOnly = sp.kind === "corporate";
  const query = (sp.q ?? "").trim();
  const sort = parseSort(sp.sort, sp.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(sp.size);
  const page = parsePage(sp.page);

  const supabase = await createClient();

  // Tab counts — unaffected by the search box or the corporate chip, same as
  // every other param-driven status bar in the app, so the numbers on the
  // tabs describe the whole inbox and don't shuffle as someone types.
  const countFor = async (t: StatusTab): Promise<number> => {
    let q = supabase.from("contact_messages").select("id", { count: "exact", head: true });
    if (t !== "all") q = q.eq("status", t);
    const { count } = await q;
    return count ?? 0;
  };
  const [countNew, countReplied, countBooked, countClosed, countAll] = await Promise.all([
    countFor("new"),
    countFor("replied"),
    countFor("booked"),
    countFor("closed"),
    countFor("all"),
  ]);
  const COUNTS: Record<StatusTab, number> = {
    new: countNew,
    replied: countReplied,
    booked: countBooked,
    closed: countClosed,
    all: countAll,
  };

  let listQuery = supabase
    .from("contact_messages")
    .select("id, name, email, phone, subject, message, status, kind, created_at, attribution", {
      count: "exact",
    });
  if (status !== "all") listQuery = listQuery.eq("status", status);
  if (corporateOnly) listQuery = listQuery.eq("kind", "corporate");
  for (const clause of patientSearchOrClauses(query, ["name", "email", "phone", "subject"])) {
    listQuery = listQuery.or(clause);
  }
  const [from, to] = rangeFor(page, size);
  listQuery = listQuery
    .order(sort.key, { ascending: sort.dir === "asc" })
    .order("id", { ascending: true })
    .range(from, to);

  const { data, error, count } = await listQuery;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as MessageRow[];
  const total = count ?? 0;
  const totalPages = pageCount(total, size);
  const isFiltered = query.length > 0 || corporateOnly;

  // Every param this page's links round-trip, at its default omitted so page
  // 1 on the New tab with no filters stays the bare /staff/messages URL.
  const baseParams: Record<string, string | null> = {
    status: status === "new" ? null : status,
    kind: corporateOnly ? "corporate" : null,
    q: query || null,
    sort: sort.key === DEFAULT_SORT.key ? null : sort.key,
    dir: sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir ? null : sort.dir,
    size: size !== DEFAULT_PAGE_SIZE ? String(size) : null,
  };

  const tabHref = (t: StatusTab) =>
    buildListHref(BASE_PATH, baseParams, { status: t === "new" ? null : t, page: null });

  const kindToggleHref = buildListHref(BASE_PATH, baseParams, {
    kind: corporateOnly ? null : "corporate",
    page: null,
  });

  const sortHref = (key: SortColumn) => {
    const nextDir = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
    return buildListHref(
      BASE_PATH,
      baseParams,
      {
        sort: key === DEFAULT_SORT.key && nextDir === DEFAULT_SORT.dir ? null : key,
        dir: key === DEFAULT_SORT.key && nextDir === DEFAULT_SORT.dir ? null : nextDir,
        page: null,
      },
    );
  };

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME["/staff/messages"]}
        subtitle="Messages visitors send from the contact form on drmed.ph — the Contact page and the “Send us a message” section at the bottom of the home page. Reply by phone, text or email, then keep the status up to date."
      />

      <nav className={sectionTabsNavClass} aria-label="Message status filter">
        {STATUS_TABS.map((tab) => {
          const active = status === tab.value;
          return (
            <Link
              key={tab.value}
              href={tabHref(tab.value)}
              className={sectionTabClass(active)}
              aria-current={active ? "page" : undefined}
            >
              {tab.label} ({COUNTS[tab.value].toLocaleString("en-PH")})
            </Link>
          );
        })}
      </nav>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form method="GET" className="flex items-center gap-2">
          {status !== "new" ? <input type="hidden" name="status" value={status} /> : null}
          {corporateOnly ? <input type="hidden" name="kind" value="corporate" /> : null}
          <input type="hidden" name="sort" value={sort.key} />
          <input type="hidden" name="dir" value={sort.dir} />
          <input type="hidden" name="size" value={String(size)} />
          <label htmlFor="messages-q" className="sr-only">
            Search messages
          </label>
          <input
            id="messages-q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Search name, email, phone or subject…"
            className="w-64 max-w-full rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
          />
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm font-semibold hover:border-[color:var(--color-brand-cyan)]"
          >
            Search
          </button>
        </form>

        <Link
          href={kindToggleHref}
          aria-pressed={corporateOnly}
          className={`min-h-11 inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
            corporateOnly
              ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-text-soft)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          Corporate / HMO only
        </Link>
      </div>

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <SortableTh
                label="Received"
                href={sortHref("created_at")}
                state={ariaSortFor(sort, "created_at")}
              />
              <SortableTh label="From" href={sortHref("name")} state={ariaSortFor(sort, "name")} />
              <PlainTh label="Contact" />
              <PlainTh label="Subject" />
              <PlainTh label="Message" />
              <SortableTh label="Status" href={sortHref("status")} state={ariaSortFor(sort, "status")} />
              <PlainTh label="Ad campaign" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {isFiltered ? "No messages match your search." : EMPTY_LABEL[status]}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-soft)]">
                    <Link href={`${BASE_PATH}/${r.id}`} className="hover:underline">
                      {manilaDateTime(r.created_at)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`${BASE_PATH}/${r.id}`}
                      className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                    >
                      {r.name}
                    </Link>
                    {r.kind === "corporate" ? (
                      <p className="mt-1 inline-block rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-900">
                        Corporate / HMO
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.phone ? <p>{r.phone}</p> : null}
                    {r.email ? <p className="text-xs">{r.email}</p> : null}
                    {!r.phone && !r.email ? <span>—</span> : null}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.subject ?? "—"}
                  </td>
                  <td className="px-4 py-3 min-w-72 max-w-md text-[color:var(--color-brand-text-mid)]">
                    <MessageCell id={r.id} message={r.message} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status] ?? ""}`}
                    >
                      {contactMessageStatusLabel(r.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                    {attributionCampaignLabel(r.attribution as Attribution | null) ?? "—"}
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
            ? buildListHref(BASE_PATH, baseParams, { page: page - 1 > 1 ? String(page - 1) : null })
            : null
        }
        nextHref={
          page < totalPages ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) }) : null
        }
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: buildListHref(BASE_PATH, baseParams, {
            size: s === DEFAULT_PAGE_SIZE ? null : String(s),
            page: null,
          }),
        }))}
        noun="message"
      />
    </div>
  );
}

/** The Message column: the whole message when it is short; otherwise a
 * one-line preview that expands in place to the full text, so reception can
 * read every message without leaving the list. */
function MessageCell({ id, message }: { id: string; message: string }) {
  const preview = messagePreview(message);
  if (!preview.truncated) return <>{preview.text}</>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">{preview.text}</span>
        <span className="mt-1 block text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline">
          <span className="group-open:hidden">Show full message</span>
          <span className="hidden group-open:inline">Hide full message</span>
        </span>
      </summary>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed">{message}</p>
      <Link
        href={`${BASE_PATH}/${id}`}
        className="mt-2 inline-block text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Open to reply or book →
      </Link>
    </details>
  );
}
