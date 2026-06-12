import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import {
  sectionTabsNavClass,
  sectionTabClass,
} from "@/components/staff/section-tabs-style";
import { Panel } from "@/components/ui/panel";
import {
  visitStage,
  outstandingLabImagingNames,
  type QueueStage,
  type QueueTestLike,
} from "@/lib/visits/queue-stage";
import { VisitsTabs } from "../_components/visits-tabs";

export const metadata = {
  title: "Queue — staff",
};

// Today-scoped, live reception worklist. Payment and test-status changes drive
// the buckets, so the page must always render the current row of the DB.
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

const STAGE_EMPTY: Record<QueueStage, string> = {
  waiting: "No visits waiting for payment. The counter's all caught up.",
  processing: "Nothing in processing — no lab or imaging work outstanding.",
  completed: "No completed visits yet today.",
};

type QueueTestRow = {
  id: string;
  status: string;
  is_package_header: boolean;
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
  patients: {
    id: string;
    drm_id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
  };
  test_requests: QueueTestRow[] | null;
};

// A classified visit: the raw row plus its flattened tests (services join
// collapsed to section/name) so the pure stage helpers can read it.
type QueueEntry = {
  visit: QueueVisitRow;
  tests: QueueTestLike[];
};

function flattenTests(v: QueueVisitRow): QueueTestLike[] {
  return (v.test_requests ?? []).map((t) => {
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
  searchParams: Promise<{ stage?: string }>;
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

  const today = todayManilaISODate();
  const supabase = await createClient();

  const { data } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status, total_php, paid_php, created_at,
        patients!inner ( id, drm_id, first_name, middle_name, last_name ),
        test_requests ( id, status, is_package_header, services ( section, kind, name ) )
      `,
    )
    .eq("visit_date", today)
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
    buckets[visitStage(visit.payment_status, tests)].push({ visit, tests });
  }

  // Waiting / Processing read as a FIFO worklist (oldest at the top, already
  // the query order). Completed reads better newest-first.
  const rows =
    stage === "completed" ? [...buckets.completed].reverse() : buckets[stage];

  const countFor = (s: QueueStage) => buckets[s].length;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="visits-queue"
        subscriptions={[
          { table: "visits", event: "UPDATE" },
          { table: "visits", event: "INSERT" },
          { table: "payments", event: "INSERT" },
          { table: "test_requests", event: "UPDATE" },
          { table: "test_requests", event: "INSERT" },
        ]}
      />

      <header className="mb-4">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Queue
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Today&apos;s visits ({today}) · {visits.length} total — pay, process,
          done.
        </p>
      </header>

      <div className="mb-6">
        <VisitsTabs />
      </div>

      <nav className={sectionTabsNavClass} aria-label="Queue stage">
        {STAGE_TABS.map((tab) => {
          const active = stage === tab.value;
          return (
            <Link
              key={tab.value}
              href={`/staff/visits/queue?stage=${tab.value}`}
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
          {STAGE_EMPTY[stage]}
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
                    {stage === "processing" ? "Outstanding" : "Status"}
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
                  <QueueRow key={entry.visit.id} entry={entry} stage={stage} />
                ))}
              </tbody>
            </table>
          </Panel>

          {/* Mobile cards */}
          <div className="mt-6 space-y-3 md:hidden">
            {rows.map((entry) => (
              <QueueCard key={entry.visit.id} entry={entry} stage={stage} />
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
  if (stage === "processing") {
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

// Outstanding lab/imaging summary for a Processing row: up to three names then
// "+N more", so reception can tell the patient what they're still waiting on.
function OutstandingSummary({ tests }: { tests: QueueTestLike[] }) {
  const names = outstandingLabImagingNames(tests);
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

function QueueRow({ entry, stage }: { entry: QueueEntry; stage: QueueStage }) {
  const { visit } = entry;
  const status = visit.payment_status;
  return (
    <tr className="align-top hover:bg-[color:var(--color-brand-bg)]">
      <td className="px-4 py-3 font-mono text-xs">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          #{String(visit.visit_number).padStart(4, "0")}
        </Link>
      </td>
      <td className="px-4 py-3">
        <PatientCell visit={visit} />
      </td>
      <td className="px-4 py-3">
        {stage === "processing" ? (
          <OutstandingSummary tests={entry.tests} />
        ) : (
          <span
            className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[status] ?? ""}`}
          >
            {paymentStatusLabel(status)}
          </span>
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
          PHP.format(Number(visit.paid_php))
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <ActionLink visit={visit} stage={stage} />
      </td>
    </tr>
  );
}

function QueueCard({ entry, stage }: { entry: QueueEntry; stage: QueueStage }) {
  const { visit } = entry;
  const status = visit.payment_status;
  return (
    <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
      <div className="flex items-center justify-between">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="font-mono text-xs text-[color:var(--color-brand-cyan)] hover:underline"
        >
          #{String(visit.visit_number).padStart(4, "0")}
        </Link>
        <span
          className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[status] ?? ""}`}
        >
          {paymentStatusLabel(status)}
        </span>
      </div>
      <div className="mt-1">
        <PatientCell visit={visit} />
      </div>
      {stage === "processing" ? (
        <p className="mt-2 text-xs">
          <span className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Outstanding:{" "}
          </span>
          <OutstandingSummary tests={entry.tests} />
        </p>
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
            </span>
          )}
        </div>
        <ActionLink visit={visit} stage={stage} />
      </div>
    </article>
  );
}
