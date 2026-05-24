import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { queueTitleForRole, sectionsForRole } from "@/lib/auth/role-sections";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { ClaimButton } from "./claim-button";

// ---------------------------------------------------------------------------
// Queue card types — after the grouping fold
// ---------------------------------------------------------------------------
type QueueCardSingle = {
  kind: "single";
  testRequestId: string;
  requestedAt: string;
  label: string;
  code: string;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
};

type QueueCardGrouped = {
  kind: "grouped";
  visitId: string;
  groupId: string;
  groupCode: string;
  label: string;
  orderedTests: Array<{ code: string; name: string }>;
  requestedAt: string;
  visitNumber: string;
  patientName: string;
  patientDrmId: string;
  status: string;
  claimedBy: string | null;
  href: string;
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

interface SearchProps {
  searchParams: Promise<{ filter?: "mine" | "all" }>;
}

export default async function QueuePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const filter = params.filter ?? "all";

  const session = await requireActiveStaff();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Each role sees only the sections it operates on. medtech doesn't see
  // imaging_xray (handled by xray_technician), and vice versa. admin /
  // pathologist see everything.
  const allowedSections = sectionsForRole(session.role);

  let query = supabase
    .from("test_requests")
    .select(
      `
        id, status, requested_at, assigned_to, started_at, visit_id,
        services!inner ( id, code, name, turnaround_hours, section, report_group_id,
          report_groups ( code, name ) ),
        visits!inner (
          id, visit_number,
          patients!inner ( id, drm_id, first_name, last_name )
        )
      `,
    )
    .in("status", ["requested", "in_progress"])
    .eq("is_package_header", false)
    .order("requested_at", { ascending: true })
    .limit(100);

  if (allowedSections !== null && allowedSections.length > 0) {
    query = query.in("services.section", allowedSections);
  }

  if (filter === "mine" && user) {
    query = query.eq("assigned_to", user.id);
  }

  const { data: rows } = await query;
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

    if (svc.report_group_id && rg) {
      const key = `${r.visit_id}|${svc.report_group_id}`;
      const existing = groupedAcc.get(key);
      const test = { code: svc.code, name: svc.name };
      if (existing) {
        existing.orderedTests.push(test);
        existing.label = `${rg.name} (${existing.orderedTests.length} tests)`;
        if (statusRank(r.status) < statusRank(existing.status)) {
          existing.status = r.status;
        }
        // Treat the card as unclaimed if any member is unclaimed.
        if (!r.assigned_to) existing.claimedBy = null;
        // Keep earliest requested_at for display.
        if (r.requested_at < existing.requestedAt) {
          existing.requestedAt = r.requested_at;
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
          visitNumber: visit.visit_number,
          patientName,
          patientDrmId: patient.drm_id,
          status: r.status,
          claimedBy: r.assigned_to,
          href: `/staff/queue/consolidated/${r.visit_id}/${svc.report_group_id}`,
        });
      }
    } else {
      cards.push({
        kind: "single",
        testRequestId: r.id,
        requestedAt: r.requested_at,
        label: svc.name,
        code: svc.code,
        visitNumber: visit.visit_number,
        patientName,
        patientDrmId: patient.drm_id,
        status: r.status,
        claimedBy: r.assigned_to,
        href: `/staff/queue/${r.id}`,
      });
    }
  }
  cards.push(...groupedAcc.values());
  // Sort by requestedAt ascending (oldest first) — mirrors the query order
  // but ensures grouped cards (which may have been inserted after single
  // cards) sort consistently.
  cards.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="queue-page"
        subscriptions={[
          { table: "test_requests", event: "INSERT" },
          { table: "test_requests", event: "UPDATE" },
        ]}
      />
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {queueTitle}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Tests requested or in progress, oldest first.
          </p>
        </div>
        <nav className="flex gap-2 text-sm">
          <FilterTab href="/staff/queue" label="All" active={filter === "all"} />
          <FilterTab
            href="/staff/queue?filter=mine"
            label="Mine"
            active={filter === "mine"}
          />
        </nav>
      </header>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {cards.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  Queue is empty.
                </td>
              </tr>
            ) : (
              cards.map((card) => {
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
                          {card.patientDrmId} · Visit #{card.visitNumber}
                        </p>
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
                        {card.patientDrmId} · Visit #{card.visitNumber}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {card.label}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {card.groupCode}
                        {" · "}
                        {card.orderedTests.map((t) => t.code).join(", ")}
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
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={card.href}
                        className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
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
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 font-semibold ${
        active
          ? "bg-[color:var(--color-brand-navy)] text-white"
          : "border border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
      }`}
    >
      {label}
    </Link>
  );
}
