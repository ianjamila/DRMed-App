import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import {
  friendlyManilaDate,
  isISODate,
  shiftISODate,
  todayManilaISODate,
} from "@/lib/dates/manila";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { PageHeader } from "@/components/staff/page-header";
import { RealtimeRefresher, type Subscription } from "@/components/staff/realtime-refresher";
import {
  sectionTabsNavClass,
  sectionTabClass,
} from "@/components/staff/section-tabs-style";
import { Panel } from "@/components/ui/panel";
import {
  visitStage,
  outstandingLabImagingNames,
  releasedLabImagingNames,
  type QueueStage,
  type QueueTestLike,
} from "@/lib/visits/queue-stage";
import { visitDeletability, hasOpenHmoClaim } from "@/lib/visits/deletion";
import { shouldPrintReceipt } from "@/lib/visits/receipt-policy";
import { waivedAmount } from "@/lib/visits/statement";
import { countReleasedLines } from "@/lib/visits/payment-edit";
import { QueueDeleteDialog } from "@/components/staff/queue-delete-dialog";
import { SampleBadge } from "@/components/staff/sample-badge";

const QUEUE_SUBSCRIPTIONS = [
  { table: "visits", event: "UPDATE" },
  { table: "visits", event: "INSERT" },
  { table: "payments", event: "INSERT" },
  { table: "test_requests", event: "UPDATE" },
  { table: "test_requests", event: "INSERT" },
] as const satisfies readonly Subscription[];

export const metadata = {
  title: "Reception Queue",
};

// Day-scoped, live reception worklist — today by default, any past day via the
// picker. Payment and test-status changes drive the buckets, so the page must
// always render the current row of the DB.
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const STATUS_BADGE: Record<string, string> = {
  paid: "bg-green-50 text-green-700 border-green-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  waived: "bg-blue-50 text-blue-700 border-blue-200",
};

// Stage logic (bucketing rules) lives in the pure, unit-tested
// @/lib/visits/queue-stage module. This page owns only the DB read + UI.

const STAGE_TABS: { value: QueueStage; label: string }[] = [
  { value: "waiting", label: "Waiting for payment" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
];

// Reception's next move when the counter is clear: start the visit for whoever
// just walked up. This used to be the "New visit" entry in the Visits section-tab
// bar, which grouped the queue with /staff/visits purely because they share a URL
// prefix — a live worklist, a records archive and a creation form are three jobs,
// not three views of one. The shortcut is real, so it stays; as an action, not a tab.
function NewVisitLink() {
  return (
    <Link
      href="/staff/visits/new"
      className="inline-flex min-h-11 items-center rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
    >
      + New visit
    </Link>
  );
}

const STAGE_EMPTY_TODAY: Record<QueueStage, string> = {
  waiting: "No visits waiting for payment. The counter's all caught up.",
  processing: "Nothing in processing — no lab or imaging work outstanding.",
  completed: "No completed visits yet today.",
};

// Past days read as history, not as a worklist — the copy has to follow.
const STAGE_EMPTY_PAST: Record<QueueStage, string> = {
  waiting: "No visits were left waiting for payment on this day.",
  processing: "No visit was still in processing on this day.",
  completed: "No visits were completed on this day.",
};

// Stage tabs and the day picker each have to carry the other's selection, or
// switching one silently resets the other. `date` is omitted when it's today so
// the default view keeps a clean /staff/visits/queue?stage=… URL.
function queueHref(stage: QueueStage, date: string, today: string): string {
  const params = new URLSearchParams({ stage });
  if (date !== today) params.set("date", date);
  return `/staff/visits/queue?${params.toString()}`;
}

type QueueTestRow = {
  id: string;
  status: string;
  deleted_at: string | null;
  is_package_header: boolean;
  // Hand-written row types are `.returns<>()`-asserted, so tsc cannot tell you
  // this is missing — it just types the embed as absent. Keep it in step with
  // the select above by hand.
  hmo_claim_items: { batch_voided: boolean }[] | null;
  services:
    | { section: string | null; kind: string; name: string }
    | { section: string | null; kind: string; name: string }[]
    | null;
};

type QueueVisitRow = {
  id: string;
  visit_number: string;
  visit_date: string;
  payment_status: string;
  total_php: number;
  paid_php: number;
  created_at: string;
  hmo_provider_id: string | null;
  is_sample: boolean;
  patients: {
    id: string;
    drm_id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
  };
  hmo_providers: { name: string } | { name: string }[] | null;
  test_requests: QueueTestRow[] | null;
};

// PostgREST returns an embedded row as either an object or a one-element
// array depending on the join shape — handle both (mirrors patient-ar's
// pluckProviderName). Falls back to a bare "HMO" chip when the name is
// missing rather than hiding the HMO status.
function pluckProviderName(
  v: { name: string } | { name: string }[] | null,
): string | null {
  if (!v) return null;
  const row = Array.isArray(v) ? v[0] : v;
  return row?.name ?? null;
}

// A classified visit: the raw row plus its flattened tests (services join
// collapsed to section/name) so the pure stage helpers can read it.
type QueueEntry = {
  visit: QueueVisitRow;
  tests: QueueTestLike[];
};

function flattenTests(v: QueueVisitRow): QueueTestLike[] {
  // Soft-deleted lines are not part of the visit's workload or bill (0125) —
  // drop them before the stage helpers ever see them.
  return (v.test_requests ?? [])
    .filter((t) => t.deleted_at === null)
    .map((t) => {
    const svc = Array.isArray(t.services) ? t.services[0] : t.services;
    return {
      status: t.status,
      is_package_header: t.is_package_header,
      section: svc?.section ?? null,
      name: svc?.name ?? null,
    };
  });
}

interface SearchProps {
  searchParams: Promise<{ stage?: string; date?: string }>;
}

export default async function VisitsQueuePage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const sp = await searchParams;
  const stage: QueueStage =
    sp.stage === "processing" || sp.stage === "completed"
      ? sp.stage
      : "waiting";

  // The picker only ever looks backwards: a visit_date is stamped when the
  // visit is created, so there is nothing to see ahead of today.
  const today = todayManilaISODate();
  const date = isISODate(sp.date) && sp.date <= today ? sp.date : today;
  const isToday = date === today;
  const prevDate = shiftISODate(date, -1);
  const nextDate = shiftISODate(date, 1);

  const supabase = await createClient();

  const { data } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status, total_php, paid_php, created_at,
        hmo_provider_id, is_sample,
        patients!inner ( id, drm_id, first_name, middle_name, last_name ),
        hmo_providers ( name ),
        test_requests ( id, status, deleted_at, is_package_header, hmo_claim_items ( batch_voided ), services ( section, kind, name ) )
      `,
    )
    .eq("visit_date", date)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .returns<QueueVisitRow[]>();

  const visits = data ?? [];

  // Classify every visit once, then bucket. Counts drive the tab labels so the
  // receptionist sees the whole day at a glance regardless of the active tab.
  const buckets: Record<QueueStage, QueueEntry[]> = {
    waiting: [],
    processing: [],
    completed: [],
  };
  for (const visit of visits) {
    const tests = flattenTests(visit);
    buckets[visitStage(visit, tests)].push({ visit, tests });
  }

  // Waiting / Processing read as a FIFO worklist (oldest at the top, already
  // the query order). Completed reads better newest-first.
  const rows =
    stage === "completed" ? [...buckets.completed].reverse() : buckets[stage];

  const countFor = (s: QueueStage) => buckets[s].length;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      {/* Live updates only matter for today — a past day can't change under you. */}
      {isToday ? (
        <RealtimeRefresher
          channelName="visits-queue"
          subscriptions={QUEUE_SUBSCRIPTIONS}
        />
      ) : null}

      <PageHeader
        title="Reception Queue"
        subtitle={
          <>
            {isToday ? "Today's visits" : "Visits"} ({friendlyManilaDate(date)}) ·{" "}
            {visits.length} total — pay, process, done.
          </>
        }
        actions={<NewVisitLink />}
      />

      <form
        className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
        action="/staff/visits/queue"
      >
        {/* Keep the open stage tab when the day changes. */}
        <input type="hidden" name="stage" value={stage} />
        <div className="flex flex-col">
          <label
            htmlFor="date"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Day
          </label>
          <input
            type="date"
            id="date"
            name="date"
            defaultValue={date}
            max={today}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Show day
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={queueHref(stage, prevDate, today)}
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            ← Previous day
          </Link>
          {isToday ? (
            <span
              aria-disabled="true"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50"
            >
              Next day →
            </span>
          ) : (
            <Link
              href={queueHref(stage, nextDate, today)}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              Next day →
            </Link>
          )}
          {isToday ? null : (
            <Link
              href={queueHref(stage, today, today)}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-bold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white"
            >
              Back to today
            </Link>
          )}
        </div>
      </form>

      {isToday ? null : (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          You&apos;re looking at a past day, not today&apos;s live queue. Rows
          here don&apos;t refresh on their own.
        </p>
      )}

      <nav className={sectionTabsNavClass} aria-label="Queue stage">
        {STAGE_TABS.map((tab) => {
          const active = stage === tab.value;
          return (
            <Link
              key={tab.value}
              href={queueHref(tab.value, date, today)}
              className={sectionTabClass(active)}
              aria-current={active ? "page" : undefined}
            >
              {tab.label} ({countFor(tab.value)})
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <Panel className="mt-6 p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          {(isToday ? STAGE_EMPTY_TODAY : STAGE_EMPTY_PAST)[stage]}
          {/* Today's Waiting bucket only — that's the landing view, and an empty
              counter is the one moment starting a visit is the obvious next step.
              Past days read as history, and Processing/Completed being empty says
              nothing about whether a new visit is wanted. */}
          {isToday && stage === "waiting" ? (
            <div className="mt-4 flex justify-center">
              <NewVisitLink />
            </div>
          ) : null}
        </Panel>
      ) : (
        <>
          {/* Desktop table */}
          <Panel className="mt-6 hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Visit #</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">
                    {stage === "processing" ? "Outstanding / Released" : "Status"}
                  </th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">
                    {stage === "waiting" ? "Balance" : "Paid"}
                  </th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((entry) => (
                  <QueueRow
                    key={entry.visit.id}
                    entry={entry}
                    stage={stage}
                    canDelete={canDeleteEntry(session.role, entry)}
                  />
                ))}
              </tbody>
            </table>
          </Panel>

          {/* Mobile cards */}
          <div className="mt-6 space-y-3 md:hidden">
            {rows.map((entry) => (
              <QueueCard
                key={entry.visit.id}
                entry={entry}
                stage={stage}
                canDelete={canDeleteEntry(session.role, entry)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function balanceOf(v: QueueVisitRow): number {
  const b = Number(v.total_php) - Number(v.paid_php);
  return b > 0 ? b : 0;
}

// Delete shows only where decision 6 allows it: unpaid visits, reception or
// admin. The page already excludes soft-deleted visits from the query.
function canDeleteEntry(role: string, entry: QueueEntry): boolean {
  return visitDeletability(role, {
    payment_status: entry.visit.payment_status,
    deleted_at: null,
    test_statuses: entry.tests.map((t) => t.status),
    // Off the RAW rows, not the deleted-filtered `entry.tests`: the P0050
    // trigger does not filter `tr.deleted_at` either, because a line deleted
    // earlier whose claim is still open is exactly the receivable it protects.
    has_open_hmo_claim: (entry.visit.test_requests ?? []).some((t) =>
      hasOpenHmoClaim(t.hmo_claim_items),
    ),
  }).ok;
}

function ActionLink({
  visit,
  stage,
}: {
  visit: QueueVisitRow;
  stage: QueueStage;
}) {
  if (stage === "waiting") {
    return (
      <Link
        href={`/staff/payments/new?visit_id=${visit.id}`}
        className="inline-block min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
      >
        Record payment
      </Link>
    );
  }
  // Item 1 / decision 4: a consultation-only visit has no slip to reprint, so
  // the completed row falls back to the same "Open visit" link as Processing.
  const printsReceipt = shouldPrintReceipt(
    (visit.test_requests ?? [])
      .filter((t) => t.deleted_at === null)
      .map((t) => (Array.isArray(t.services) ? t.services[0] : t.services))
      .map((svc) => svc?.kind)
      .filter((kind): kind is string => Boolean(kind)),
  );
  if (stage === "processing" || !printsReceipt) {
    return (
      <Link
        href={`/staff/visits/${visit.id}`}
        className="inline-block min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white"
      >
        Open visit
      </Link>
    );
  }
  return (
    <Link
      href={`/staff/visits/${visit.id}/receipt`}
      className="inline-block min-h-9 rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-cyan)] transition-colors hover:bg-[color:var(--color-brand-cyan)] hover:text-white"
    >
      Print billing
    </Link>
  );
}

// Up-to-three names then "+N more" — shared by the Outstanding and Released
// summaries on Processing rows.
function NameSummary({ names }: { names: string[] }) {
  if (names.length === 0) return <span>—</span>;
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return (
    <span className="text-[color:var(--color-brand-text-mid)]">
      {shown.join(", ")}
      {extra > 0 ? (
        <span className="text-[color:var(--color-brand-text-soft)]">
          {" "}
          +{extra} more
        </span>
      ) : null}
    </span>
  );
}

// Processing rows tell reception both what the patient is still waiting on and
// what has already been released (already-released tests used to be invisible
// here — the Visit #0037 class of confusion).
function ProcessingTestsSummary({ tests }: { tests: QueueTestLike[] }) {
  const outstanding = outstandingLabImagingNames(tests);
  const released = releasedLabImagingNames(tests);
  return (
    <div className="space-y-0.5">
      <p className="text-xs">
        <span className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Outstanding:{" "}
        </span>
        <NameSummary names={outstanding} />
      </p>
      <p className="text-xs">
        <span className="font-bold uppercase tracking-wider text-emerald-700">
          Released:{" "}
        </span>
        <NameSummary names={released} />
      </p>
    </div>
  );
}

function PatientCell({ visit }: { visit: QueueVisitRow }) {
  const p = visit.patients;
  return (
    <>
      <Link
        href={`/staff/patients/${p.id}`}
        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)] hover:underline"
      >
        {formatPatientName(p)}
      </Link>
      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
        {p.drm_id}
      </p>
    </>
  );
}

// An HMO visit's payment_status is legitimately "unpaid" until the insurer
// settles months later — reusing the red "Unpaid" badge here is actively
// misleading now that HMO visits leave the Waiting bucket the moment
// they're created. Text carries the HMO/provider fact, not colour alone.
function PaymentBadge({ visit }: { visit: QueueVisitRow }) {
  if (visit.hmo_provider_id != null) {
    const providerName = pluckProviderName(visit.hmo_providers);
    return (
      <span className="inline-block rounded-md border px-2 py-0.5 text-xs font-semibold bg-blue-50 text-blue-700 border-blue-200">
        {providerName ? `HMO · ${providerName}` : "HMO"}
      </span>
    );
  }
  const status = visit.payment_status;
  return (
    <span
      className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[status] ?? ""}`}
    >
      {paymentStatusLabel(status)}
    </span>
  );
}

// Waiving writes no payment, so a waived visit reads "Paid ₱200" on a ₱1,500
// bill — which looks like money still owed, and on the Processing tab nothing
// else in the row says otherwise (the status column shows tests there). Name
// the remainder, same rule as the visit page and the statement.
function WaivedNote({ visit, inline = false }: { visit: QueueVisitRow; inline?: boolean }) {
  const waived = waivedAmount(visit);
  if (waived <= 0) return null;
  const className = "font-sans text-xs text-[color:var(--color-brand-text-soft)]";
  return inline ? (
    <span className={className}> · {PHP.format(waived)} waived</span>
  ) : (
    <div className={className}>{PHP.format(waived)} waived</div>
  );
}

// A Waiting row whose results already went out while it was paid — a
// payment deleted or moved, or a test added after the release. Released
// results stay released (owner rule); the badge only says so, so the counter
// collects the balance instead of telling the patient to wait for results
// they already have. An HMO visit never waits here, and releases unpaid by
// design anyway (0133). Counted like Patient AR's badge: results only.
function ReleasedBadge({ visit }: { visit: QueueVisitRow }) {
  if (visit.hmo_provider_id != null) return null;
  const { results } = countReleasedLines(
    (visit.test_requests ?? [])
      .filter((t) => t.deleted_at === null)
      .map((t) => {
        const svc = Array.isArray(t.services) ? t.services[0] : t.services;
        return { status: t.status, is_package_header: t.is_package_header, kind: svc?.kind };
      }),
  );
  if (results === 0) return null;
  return (
    <span
      className="ml-1.5 inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800"
      title="Results went out while this visit was paid; it owes money again. Released results stay released."
    >
      Results released · {results}
    </span>
  );
}

function QueueRow({
  entry,
  stage,
  canDelete,
}: {
  entry: QueueEntry;
  stage: QueueStage;
  canDelete: boolean;
}) {
  const { visit } = entry;
  return (
    <tr className="align-top hover:bg-[color:var(--color-brand-bg)]">
      <td className="px-4 py-3 font-mono text-xs">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          #{String(visit.visit_number).padStart(4, "0")}
        </Link>
        {visit.is_sample ? (
          <div className="mt-1">
            <SampleBadge size="compact" />
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <PatientCell visit={visit} />
      </td>
      <td className="px-4 py-3">
        {stage === "processing" ? (
          <ProcessingTestsSummary tests={entry.tests} />
        ) : (
          <>
            <PaymentBadge visit={visit} />
            {stage === "waiting" ? <ReleasedBadge visit={visit} /> : null}
          </>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {PHP.format(Number(visit.total_php))}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {stage === "waiting" ? (
          <span className="font-semibold text-red-600">
            {PHP.format(balanceOf(visit))}
          </span>
        ) : (
          <>
            {PHP.format(Number(visit.paid_php))}
            <WaivedNote visit={visit} />
          </>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <ActionLink visit={visit} stage={stage} />
        {canDelete ? (
          <div className="mt-1.5 flex justify-end">
            <QueueDeleteDialog
              visitId={visit.id}
              mode="delete"
              entryLabel={`visit #${String(visit.visit_number).padStart(4, "0")}`}
            />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function QueueCard({
  entry,
  stage,
  canDelete,
}: {
  entry: QueueEntry;
  stage: QueueStage;
  canDelete: boolean;
}) {
  const { visit } = entry;
  return (
    <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
      <div className="flex items-center justify-between">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="font-mono text-xs text-[color:var(--color-brand-cyan)] hover:underline"
        >
          #{String(visit.visit_number).padStart(4, "0")}
          {visit.is_sample ? (
            <span className="ml-2">
              <SampleBadge size="compact" />
            </span>
          ) : null}
        </Link>
        <span>
          <PaymentBadge visit={visit} />
          {stage === "waiting" ? <ReleasedBadge visit={visit} /> : null}
        </span>
      </div>
      <div className="mt-1">
        <PatientCell visit={visit} />
      </div>
      {stage === "processing" ? (
        <div className="mt-2">
          <ProcessingTestsSummary tests={entry.tests} />
        </div>
      ) : null}
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-xs">
          <span className="text-[color:var(--color-brand-text-soft)]">
            Total{" "}
          </span>
          <span className="font-mono">{PHP.format(Number(visit.total_php))}</span>
          {stage === "waiting" ? (
            <span className="ml-2">
              <span className="text-[color:var(--color-brand-text-soft)]">
                Balance{" "}
              </span>
              <span className="font-mono font-semibold text-red-600">
                {PHP.format(balanceOf(visit))}
              </span>
            </span>
          ) : (
            <span className="ml-2">
              <span className="text-[color:var(--color-brand-text-soft)]">
                Paid{" "}
              </span>
              <span className="font-mono">
                {PHP.format(Number(visit.paid_php))}
              </span>
              <WaivedNote visit={visit} inline />
            </span>
          )}
        </div>
        <ActionLink visit={visit} stage={stage} />
      </div>
      {canDelete ? (
        <div className="mt-2 flex justify-end">
          <QueueDeleteDialog
            visitId={visit.id}
            mode="delete"
            entryLabel={`visit #${String(visit.visit_number).padStart(4, "0")}`}
          />
        </div>
      ) : null}
    </article>
  );
}
