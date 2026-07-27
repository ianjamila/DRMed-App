import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
import type { Json } from "@/types/database";

export const metadata = { title: "Deleted queue entries — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Hard cap so a wide-open range can't pull the whole audit log into one
// render (same policy as the undone-releases report).
const MAX_ROWS = 500;

const DELETE_ACTIONS = ["visit.deleted", "test_request.deleted"] as const;
const RESTORE_ACTIONS = ["visit.restored", "test_request.restored"] as const;
const ALL_ACTIONS = [...DELETE_ACTIONS, ...RESTORE_ACTIONS];

interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

interface VisitRow {
  id: string;
  visit_number: string;
  deleted_at: string | null;
  total_php: number;
  patients: PatientEmbed | PatientEmbed[] | null;
}

interface TestRequestRow {
  id: string;
  deleted_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  visits:
    | { visit_number: string; deleted_at: string | null; patients: PatientEmbed | PatientEmbed[] | null }
    | { visit_number: string; deleted_at: string | null; patients: PatientEmbed | PatientEmbed[] | null }[]
    | null;
}

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// audit_log.metadata is untyped Json — narrow it to the object shape the
// deletion writers produce before reading fields.
function asRecord(meta: Json | null): Record<string, Json | undefined> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, Json | undefined>)
    : {};
}

const manilaDateTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function DeletedEntriesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  // Deletion is a corrective event, not routine — default to a wide window.
  const defaultStart = new Date(`${todayISO}T00:00:00+08:00`);
  defaultStart.setDate(defaultStart.getDate() - 90);
  const defaultStartISO = defaultStart.toISOString().slice(0, 10);

  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : defaultStartISO;
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : todayISO;

  const admin = createAdminClient();

  const { data: auditRows } = await admin
    .from("audit_log")
    .select("id, created_at, actor_id, action, resource_type, resource_id, metadata")
    .in("action", ALL_ACTIONS)
    .gte("created_at", `${start}T00:00:00+08:00`)
    .lte("created_at", `${end}T23:59:59+08:00`)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS)
    .returns<AuditRow[]>();

  const rows = auditRows ?? [];
  const capped = rows.length === MAX_ROWS;

  // Current outcome of each entry — batched by resource type.
  const visitIds = Array.from(
    new Set(
      rows
        .filter((r) => r.resource_type === "visit")
        .map((r) => r.resource_id)
        .filter((v): v is string => !!v),
    ),
  );
  const visitById = new Map<string, VisitRow>();
  if (visitIds.length > 0) {
    const { data: visits } = await admin
      .from("visits")
      .select(
        "id, visit_number, deleted_at, total_php, patients ( first_name, last_name, drm_id )",
      )
      .in("id", visitIds)
      .returns<VisitRow[]>();
    for (const v of visits ?? []) visitById.set(v.id, v);
  }

  const trIds = Array.from(
    new Set(
      rows
        .filter((r) => r.resource_type === "test_request")
        .map((r) => r.resource_id)
        .filter((v): v is string => !!v),
    ),
  );
  const trById = new Map<string, TestRequestRow>();
  if (trIds.length > 0) {
    const { data: trs } = await admin
      .from("test_requests")
      .select(
        `
        id, deleted_at, visit_id,
        services ( name, code ),
        visits ( visit_number, deleted_at, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", trIds)
      .returns<TestRequestRow[]>();
    for (const tr of trs ?? []) trById.set(tr.id, tr);
  }

  // Staff names for the "By" column.
  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_id).filter((v): v is string => !!v)),
  );
  const staffNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", actorIds);
    for (const s of staff ?? []) staffNameById.set(s.id, s.full_name);
  }

  const deleteEvents = rows.filter((r) =>
    (DELETE_ACTIONS as readonly string[]).includes(r.action),
  );
  const restoreEvents = rows.length - deleteEvents.length;
  const stillDeleted = deleteEvents.filter((r) => {
    if (!r.resource_id) return false;
    return r.resource_type === "visit"
      ? visitById.get(r.resource_id)?.deleted_at != null
      : trById.get(r.resource_id)?.deleted_at != null;
  }).length;
  const deletedValue = deleteEvents.reduce((sum, r) => {
    const meta = asRecord(r.metadata);
    const amount =
      r.resource_type === "visit" ? meta.total_php : meta.final_price_php;
    return sum + (typeof amount === "number" ? amount : 0);
  }, 0);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Deleted queue entries
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Every visit or test deleted from the queues — who deleted it, why,
          what it was worth, and whether it was restored since. Only unpaid
          entries can be deleted; anything with payments has to go through a
          payment void first.
        </p>
      </header>

      <form
        action=""
        className="my-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Deleted from
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
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Delete events"
          value={String(deleteEvents.length)}
          hint={`${start} → ${end}`}
        />
        <SummaryTile
          label="Still deleted"
          value={String(stillDeleted)}
          hint="Not restored since"
          tone={stillDeleted > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Restores"
          value={String(restoreEvents)}
          hint="Entries put back in the queue"
        />
        <SummaryTile
          label="Deleted value"
          value={formatPhp(deletedValue)}
          hint="Billed value removed at delete time"
        />
      </div>

      {capped ? (
        <p className="mb-3 text-xs text-amber-700">
          Showing the most recent {MAX_ROWS} — narrow the range to see the
          rest.
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No queue entries were deleted or restored in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Patient · Visit</th>
                  <th className="px-4 py-3">What</th>
                  <th className="px-4 py-3">By</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Current outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const meta = asRecord(r.metadata);
                  const isDelete = (
                    DELETE_ACTIONS as readonly string[]
                  ).includes(r.action);
                  const isVisit = r.resource_type === "visit";

                  const visitRow =
                    isVisit && r.resource_id
                      ? visitById.get(r.resource_id)
                      : undefined;
                  const trRow =
                    !isVisit && r.resource_id
                      ? trById.get(r.resource_id)
                      : undefined;
                  const trVisit = pluckOne(trRow?.visits ?? null);
                  const patient = isVisit
                    ? pluckOne(visitRow?.patients ?? null)
                    : pluckOne(trVisit?.patients ?? null);
                  const svc = pluckOne(trRow?.services ?? null);
                  const visitNumber = isVisit
                    ? (visitRow?.visit_number ??
                      (typeof meta.visit_number === "string" ||
                      typeof meta.visit_number === "number"
                        ? String(meta.visit_number)
                        : null))
                    : (trVisit?.visit_number ?? null);
                  const visitHref = isVisit
                    ? r.resource_id
                      ? `/staff/visits/${r.resource_id}`
                      : null
                    : trRow
                      ? `/staff/visits/${trRow.visit_id}`
                      : typeof meta.visit_id === "string"
                        ? `/staff/visits/${meta.visit_id}`
                        : null;
                  const amount = isVisit
                    ? typeof meta.total_php === "number"
                      ? meta.total_php
                      : null
                    : typeof meta.final_price_php === "number"
                      ? meta.final_price_php
                      : null;
                  const currentlyDeleted = isVisit
                    ? (visitRow?.deleted_at ?? null) != null
                    : (trRow?.deleted_at ?? null) != null ||
                      (trVisit?.deleted_at ?? null) != null;

                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime.format(new Date(r.created_at))}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            isDelete
                              ? "bg-red-100 text-red-900"
                              : "bg-emerald-100 text-emerald-900"
                          }`}
                        >
                          {isDelete ? "Deleted" : "Restored"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {patient ? (
                          <>
                            {patient.last_name}, {patient.first_name}{" "}
                            <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                              {patient.drm_id}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {visitHref ? (
                            <Link href={visitHref} className="hover:underline">
                              #{visitNumber ?? "—"}
                            </Link>
                          ) : (
                            <>#{visitNumber ?? "—"}</>
                          )}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {isVisit ? (
                          <>
                            Entire visit
                            {typeof meta.active_test_count === "number" ? (
                              <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
                                {meta.active_test_count}{" "}
                                {meta.active_test_count === 1
                                  ? "test"
                                  : "tests"}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            {svc?.name ??
                              (typeof meta.service_name === "string"
                                ? meta.service_name
                                : "—")}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {svc?.code ??
                                (typeof meta.service_code === "string"
                                  ? meta.service_code
                                  : "")}
                              {meta.is_package_header === true
                                ? " · package"
                                : ""}
                            </p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {staffNameById.get(r.actor_id ?? "") ?? "—"}
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {typeof meta.reason === "string" ? meta.reason : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {amount != null && amount > 0 ? formatPhp(amount) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {currentlyDeleted ? (
                          <span className="font-semibold text-red-700">
                            Still deleted
                          </span>
                        ) : (
                          <span className="font-semibold text-emerald-700">
                            Back in the queue
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  const accent =
    tone === "warn"
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
