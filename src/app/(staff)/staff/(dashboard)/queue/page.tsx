import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { queueTitleForRole, sectionsForRole } from "@/lib/auth/role-sections";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { ClaimButton } from "./claim-button";
import { sectionTabClass } from "@/components/staff/section-tabs-style";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import {
  isISODate,
  manilaDayWindowUtc,
  manilaRangeUtc,
  todayManilaISODate,
} from "@/lib/dates/manila";
import { matchesAllTokens } from "@/lib/patients/search";
import { visitNumberFilter } from "@/lib/visits/visit-number-filter";
import { testDeletability } from "@/lib/visits/deletion";
import { LAB_QUEUE_GATE_VISITS_OR } from "@/lib/visits/lab-gate";
import { QueueDeleteDialog } from "@/components/staff/queue-delete-dialog";

// ---------------------------------------------------------------------------
// Queue card types — after the grouping fold
// ---------------------------------------------------------------------------
type QueueCardSingle = {
  kind: "single";
  testRequestId: string;
  visitId: string;
  requestedAt: string;
  releasedAt: string | null;
  label: string;
  code: string;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
  canDelete: boolean;
};

type QueueCardGrouped = {
  kind: "grouped";
  visitId: string;
  groupId: string;
  groupCode: string;
  label: string;
  orderedTests: Array<{ code: string; name: string }>;
  requestedAt: string;
  releasedAt: string | null;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
  // All member test ids — the group deletes as one bulk action.
  memberIds: string[];
  // Only when EVERY member is deletable (a package component in the panel
  // makes the whole group non-deletable; the package deletes from the visit).
  canDelete: boolean;
};

type QueueCard = QueueCardSingle | QueueCardGrouped;

function statusRank(s: string): number {
  return s === "requested" ? 0 : s === "in_progress" ? 1 : 2;
}

export const metadata = {
  title: "Queue — staff",
};

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
};

type QueueFilter = "mine" | "all" | "pending_release" | "released_today";

// Rows per page. The queue is a live worklist that rarely fills one page, so
// the pager stays hidden day to day — but the date filter can reach back into a
// busy past day, and a hard cap there silently truncated the list. One size for
// every tab, so switching tabs doesn't resize the page under you.
const PAGE_SIZE = 100;

/** Everything a free-text search should be able to hit on one queue card. */
function cardHaystack(card: QueueCard): string {
  const tests =
    card.kind === "grouped"
      ? `${card.groupCode} ${card.orderedTests.map((t) => `${t.code} ${t.name}`).join(" ")}`
      : card.code;
  return `${card.patientName} ${card.patientDrmId} ${card.visitNumber} ${card.label} ${tests}`;
}

interface SearchProps {
  searchParams: Promise<{
    filter?: QueueFilter;
    start?: string;
    end?: string;
    q?: string;
    visit?: string;
    page?: string;
  }>;
}

export default async function QueuePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const filter = params.filter ?? "all";
  const start = isISODate(params.start) ? params.start : "";
  const end = isISODate(params.end) ? params.end : "";
  const q = params.q?.trim() ?? "";
  const visit = params.visit?.trim() ?? "";
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const todayISO = todayManilaISODate();

  const session = await requireActiveStaff();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Each role sees only the sections it operates on. medtech doesn't see
  // imaging_xray (handled by xray_technician), and vice versa. admin /
  // pathologist see everything.
  const allowedSections = sectionsForRole(session.role);

  const dateColumn = filter === "released_today" ? "released_at" : "requested_at";
  const hasDateRange = Boolean(start || end);

  let query = supabase
    .from("test_requests")
    .select(
      `
        id, status, requested_at, released_at, assigned_to, started_at, visit_id, parent_id,
        services!inner ( id, code, name, turnaround_hours, section, report_group_id,
          report_groups ( code, name ) ),
        visits!inner (
          id, visit_number, payment_status,
          patients!inner ( id, drm_id, first_name, last_name )
        )
      `,
      { count: "exact" },
    )
    // Soft-deleted lines — and every line of a soft-deleted visit — are out
    // of the worklist (0125).
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .in(
      "status",
      filter === "pending_release"
        ? ["ready_for_release"]
        : filter === "released_today"
          ? ["released"]
          : ["requested", "in_progress"],
    )
    .eq("is_package_header", false)
    .order(dateColumn, { ascending: filter !== "released_today" })
    .range(offset, offset + PAGE_SIZE - 1);

  // Payment gate (item 10, decision 1): the worklist tabs hide every test of a
  // visit that's still waiting for payment — fully paid, waived, or HMO-billed
  // visits only. Applied in the query so paging counts stay honest. "Pending
  // release" and "Released today" are records of completed work, not claimable
  // work, so they stay ungated (release itself is trigger-enforced on payment).
  const worklistTab = filter === "all" || filter === "mine";
  if (worklistTab) {
    query = query.or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" });
  }

  // The date filter acts on whichever timestamp the tab is about: when a test
  // was released on the "Released today" tab, when it was requested elsewhere.
  // Bounds are Manila calendar days — a naive `${date}T00:00:00` would be read
  // in the DB's UTC zone and shift every boundary by 8 hours.
  const { fromIso, toIso } = manilaRangeUtc(start, end);
  if (fromIso) query = query.gte(dateColumn, fromIso);
  if (toIso) query = query.lt(dateColumn, toIso);

  // "Released today" keeps its implicit day window only while no explicit range
  // is set — an explicit range is the staffer overriding the tab.
  if (filter === "released_today" && !hasDateRange) {
    const { startIso, endIso } = manilaDayWindowUtc(0);
    query = query.gte("released_at", startIso).lt("released_at", endIso);
  }

  // Section gate per role. `[]` means "no access" (reception) — it has to force
  // an empty result set, not fall through unfiltered, which is how the sibling
  // /staff/results gate is written. Guarding only on `length > 0` skipped the
  // filter entirely and showed reception every section's worklist.
  if (allowedSections !== null) {
    if (allowedSections.length === 0) {
      // Force an empty result set without breaking the query shape.
      query = query.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.in("services.section", allowedSections);
    }
  }

  if (filter === "mine" && user) {
    query = query.eq("assigned_to", user.id);
  }

  // Visit # filters server-side on the embedded visit, so it finds a test even
  // when the unfiltered queue would have run past the row cap before reaching it.
  const visitFilter = visitNumberFilter(visit);
  if (visitFilter?.kind === "exact") {
    query = query.in("visits.visit_number", visitFilter.values);
  } else if (visitFilter?.kind === "contains") {
    query = query.ilike("visits.visit_number", visitFilter.pattern);
  }

  const { data: rows, count } = await query;
  const queueTitle = queueTitleForRole(session.role);

  // -------------------------------------------------------------------------
  // Fold chemistry rows by (visit_id, report_group_id). Non-grouped rows
  // stay as single cards; grouped rows collapse to one card per group.
  // -------------------------------------------------------------------------
  const cards: QueueCard[] = [];
  const groupedAcc = new Map<string, QueueCardGrouped>();

  for (const r of rows ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    if (!svc || !visit) continue;
    const patient = Array.isArray(visit.patients)
      ? visit.patients[0]
      : visit.patients;
    if (!patient) continue;

    const patientName = `${patient.last_name}, ${patient.first_name}`;
    const rg = Array.isArray(svc.report_groups)
      ? svc.report_groups[0]
      : svc.report_groups;

    // Decision 6: reception + admin, unpaid visits, no released result, and
    // package components only via their header (from the visit page). The
    // query already excluded soft-deleted rows/visits.
    const rowDeletable = testDeletability(session.role, {
      status: r.status,
      deleted_at: null,
      parent_id: r.parent_id,
      visit_payment_status: visit.payment_status,
      visit_deleted_at: null,
    }).ok;

    if (svc.report_group_id && rg) {
      const key = `${r.visit_id}|${svc.report_group_id}`;
      const existing = groupedAcc.get(key);
      const test = { code: svc.code, name: svc.name };
      if (existing) {
        existing.orderedTests.push(test);
        existing.memberIds.push(r.id);
        existing.canDelete = existing.canDelete && rowDeletable;
        existing.label = `${rg.name} (${existing.orderedTests.length} tests)`;
        if (statusRank(r.status) < statusRank(existing.status)) {
          existing.status = r.status;
        }
        // Treat the card as unclaimed if any member is unclaimed.
        if (!r.assigned_to) existing.claimedBy = null;
        // Keep earliest requested_at for display, latest released_at — the
        // group isn't fully released until its last member is.
        if (r.requested_at < existing.requestedAt) {
          existing.requestedAt = r.requested_at;
        }
        if (r.released_at && (!existing.releasedAt || r.released_at > existing.releasedAt)) {
          existing.releasedAt = r.released_at;
        }
      } else {
        groupedAcc.set(key, {
          kind: "grouped",
          visitId: r.visit_id,
          groupId: svc.report_group_id,
          groupCode: rg.code,
          label: `${rg.name} (1 test)`,
          orderedTests: [test],
          requestedAt: r.requested_at,
          releasedAt: r.released_at,
          visitNumber: visit.visit_number,
          patientName,
          patientDrmId: patient.drm_id,
          status: r.status,
          claimedBy: r.assigned_to,
          href: `/staff/queue/consolidated/${r.visit_id}/${svc.report_group_id}`,
          memberIds: [r.id],
          canDelete: rowDeletable,
        });
      }
    } else {
      cards.push({
        kind: "single",
        testRequestId: r.id,
        visitId: r.visit_id,
        requestedAt: r.requested_at,
        releasedAt: r.released_at,
        label: svc.name,
        code: svc.code,
        visitNumber: visit.visit_number,
        patientName,
        patientDrmId: patient.drm_id,
        status: r.status,
        claimedBy: r.assigned_to,
        href: `/staff/queue/${r.id}`,
        canDelete: rowDeletable,
      });
    }
  }
  cards.push(...groupedAcc.values());

  // Free-text search runs after the fold, not in the query: an ILIKE across the
  // patients join is awkward in PostgREST (the same reason /staff/results
  // post-filters), and folding first lets one typed test code match the whole
  // consolidated chemistry card it belongs to.
  const matched = q
    ? cards.filter((c) => matchesAllTokens(cardHaystack(c), q))
    : cards;

  // Admins see who holds each in-progress claim so stuck claims are visible
  // straight from the list (unclaim/reassign lives on the detail page).
  const claimerNames = new Map<string, string>();
  if (session.role === "admin") {
    const claimerIds = Array.from(
      new Set(matched.map((c) => c.claimedBy).filter((v): v is string => !!v)),
    );
    if (claimerIds.length > 0) {
      const { data: claimers } = await supabase
        .from("staff_profiles")
        .select("id, full_name")
        .in("id", claimerIds);
      for (const p of claimers ?? []) claimerNames.set(p.id, p.full_name);
    }
  }
  // Re-apply the query's own ordering: grouped cards are appended after the
  // single ones, so the fold loses it. "Released today" reads newest-released
  // first (that's also the order its 200-row cap selects by); every other tab
  // is a worklist and reads oldest-requested first.
  matched.sort((a, b) =>
    filter === "released_today"
      ? (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "")
      : a.requestedAt.localeCompare(b.requestedAt),
  );

  // `q` is applied after the fetch, so it can only narrow the page in hand —
  // everything else is a real DB filter and counts against the whole table.
  const hasServerFilters = hasDateRange || Boolean(visit);
  const hasFilters = hasServerFilters || Boolean(q);
  // A range that ends before today can't gain rows, so live refreshes would
  // only interrupt someone reading history. An open-ended `start` still runs up
  // to now, so that stays live.
  const viewingHistory = Boolean(end) && end < todayISO;

  // Paging counts test_request rows (pre-fold), which is what the range applies
  // to — a page of rows can fold into fewer chemistry cards.
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const base: Record<string, string> = {
      filter: filter === "all" ? "" : filter,
      start,
      end,
      q,
      visit,
      page: page > 1 ? String(page) : "",
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `/staff/queue${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {viewingHistory ? null : (
        <RealtimeRefresher
          channelName="queue-page"
          subscriptions={[
            { table: "test_requests", event: "INSERT" },
            { table: "test_requests", event: "UPDATE" },
          ]}
        />
      )}
      <PageHeader
        title={queueTitle}
        subtitle={
          <>
            Tests requested or in progress, oldest first.
            {worklistTab
              ? " Visits waiting for payment appear once they're paid or HMO-covered."
              : null}
            {hasServerFilters ? ` · ${total} matching` : null}
            {q ? ` · ${matched.length} on this page match “${q}”` : null}
            {filter === "released_today" && hasDateRange
              ? " · showing the dates you picked, not just today"
              : null}
          </>
        }
        actions={
          <nav className="flex gap-2 text-sm">
            <FilterTab
              href={buildHref({ filter: "", page: null })}
              label="All"
              active={filter === "all"}
            />
            <FilterTab
              href={buildHref({ filter: "pending_release", page: null })}
              label="Pending release"
              active={filter === "pending_release"}
            />
            <FilterTab
              href={buildHref({ filter: "released_today", page: null })}
              label="Released today"
              active={filter === "released_today"}
            />
            <FilterTab
              href={buildHref({ filter: "mine", page: null })}
              label="Mine"
              active={filter === "mine"}
            />
          </nav>
        }
      />

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        action="/staff/queue"
      >
        {/* Keep the open tab when filters are applied. */}
        <input type="hidden" name="filter" value={filter === "all" ? "" : filter} />
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            {filter === "released_today" ? "Released from" : "Requested from"}
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            …to
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="q"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Patient / test search
          </label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. Castillo, CBC, DRM-0123"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="visit"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Visit #
          </label>
          <input
            type="text"
            id="visit"
            name="visit"
            defaultValue={visit}
            inputMode="numeric"
            placeholder="e.g. 37 or 0037"
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-full flex flex-wrap gap-2">
          <button
            type="submit"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Apply
          </button>
          {hasFilters ? (
            <Link
              href={buildHref({
                start: null,
                end: null,
                q: null,
                visit: null,
                page: null,
              })}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      {viewingHistory ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          You&apos;re looking at past dates, not the live queue. Rows here
          don&apos;t refresh on their own.
        </p>
      ) : null}

      {/* The search box filters the fetched page, so say so rather than let a
          page-1 miss read as "not in the queue". */}
      {q && totalPages > 1 ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          The search box only looks at the {PAGE_SIZE} tests on this page. Narrow
          the dates or use Visit # to search the whole queue.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Visit</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {matched.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {hasFilters
                    ? "No queued tests match these filters."
                    : "Queue is empty."}
                </td>
              </tr>
            ) : (
              matched.map((card) => {
                if (card.kind === "single") {
                  return (
                    <tr
                      key={card.testRequestId}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        {new Date(card.requestedAt).toLocaleString("en-PH", {
                          timeZone: "Asia/Manila",
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={card.href}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {card.patientName}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {card.patientDrmId}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${card.visitId}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        >
                          #{card.visitNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {card.label}
                        </p>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {card.code}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            TEST_STATUS_STYLE[card.status] ?? ""
                          }`}
                        >
                          {card.status.replace(/_/g, " ")}
                        </span>
                        {card.claimedBy && claimerNames.has(card.claimedBy) ? (
                          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                            Claimed by {claimerNames.get(card.claimedBy)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {card.status === "requested" ? (
                          <ClaimButton
                            testRequestId={card.testRequestId}
                            navigateOnClaim
                          />
                        ) : (
                          <Link
                            href={card.href}
                            className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                          >
                            Open →
                          </Link>
                        )}
                        {card.canDelete ? (
                          <div className="mt-1.5 flex justify-end">
                            <QueueDeleteDialog
                              visitId={card.visitId}
                              testRequestIds={[card.testRequestId]}
                              mode="delete"
                              entryLabel={card.label}
                            />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                }

                // Grouped card (chemistry consolidated report)
                return (
                  <tr
                    key={`${card.visitId}|${card.groupId}`}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {new Date(card.requestedAt).toLocaleString("en-PH", {
                        timeZone: "Asia/Manila",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={card.href}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {card.patientName}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {card.patientDrmId}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/visits/${card.visitId}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        #{card.visitNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {card.label}
                      </p>
                      <div className="flex max-w-md flex-wrap items-baseline gap-x-1.5 gap-y-1 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        <span>{card.groupCode} ·</span>
                        {card.orderedTests.map((t) => (
                          <span key={t.code}>{t.code}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[card.status] ?? ""
                        }`}
                      >
                        {card.status.replace(/_/g, " ")}
                      </span>
                      {card.claimedBy && claimerNames.has(card.claimedBy) ? (
                        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                          Claimed by {claimerNames.get(card.claimedBy)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={card.href}
                        className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open →
                      </Link>
                      {card.canDelete ? (
                        <div className="mt-1.5 flex justify-end">
                          <QueueDeleteDialog
                            visitId={card.visitId}
                            testRequestIds={card.memberIds}
                            mode="delete"
                            entryLabel={card.label}
                          />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      {totalPages > 1 ? (
        <nav
          className="mt-6 flex flex-wrap items-center justify-between gap-3"
          aria-label="Queue pages"
        >
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            Page {safePage} of {totalPages} · {total} test
            {total === 1 ? "" : "s"}
          </p>
          <div className="flex gap-2">
            {safePage > 1 ? (
              <Link
                href={buildHref({
                  page: safePage > 2 ? String(safePage - 1) : null,
                })}
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
              >
                ← Previous
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50"
              >
                ← Previous
              </span>
            )}
            {safePage < totalPages ? (
              <Link
                href={buildHref({ page: String(safePage + 1) })}
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
              >
                Next →
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50"
              >
                Next →
              </span>
            )}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function FilterTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link href={href} className={sectionTabClass(active)}>
      {label}
    </Link>
  );
}
