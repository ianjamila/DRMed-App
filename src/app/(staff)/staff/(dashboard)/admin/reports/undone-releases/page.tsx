import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { Panel } from "@/components/ui/panel";
import type { Json } from "@/types/database";

export const metadata = { title: "Undone releases — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Hard cap so a wide-open range can't pull the whole audit log into one
// render (same policy as the staff-advances report).
const MAX_ROWS = 500;

interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

interface VisitEmbed {
  visit_number: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

interface TestRequestRow {
  id: string;
  status: string;
  released_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  // test_requests has no direct patients FK — reach the patient via visits.
  visits: VisitEmbed | VisitEmbed[] | null;
}

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// audit_log.metadata is untyped Json — narrow it to the object shape the
// undo writers produce before reading fields.
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

const manilaDate = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
});

export default async function UndoneReleasesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  // Undo is a rare corrective event — default to a wide (90-day) window.
  const defaultStart = new Date(`${todayISO}T00:00:00+08:00`);
  defaultStart.setDate(defaultStart.getDate() - 90);
  const defaultStartISO = defaultStart.toISOString().slice(0, 10);

  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : defaultStartISO;
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : todayISO;

  const admin = createAdminClient();

  // Staff undos carry the reason + viewed_count; cascade rows written by the
  // 0110 trigger are actor_type='system' with metadata.cascaded_from.
  const { data: auditRows } = await admin
    .from("audit_log")
    .select("id, created_at, actor_id, actor_type, resource_id, metadata")
    .eq("action", "test_request.release_undone")
    .gte("created_at", `${start}T00:00:00+08:00`)
    .lte("created_at", `${end}T23:59:59+08:00`)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS)
    .returns<AuditRow[]>();

  const rows = auditRows ?? [];
  const capped = rows.length === MAX_ROWS;

  // Current outcome of each undone test — one batched fetch.
  const resourceIds = Array.from(
    new Set(rows.map((r) => r.resource_id).filter((v): v is string => !!v)),
  );
  const trById = new Map<string, TestRequestRow>();
  if (resourceIds.length > 0) {
    const { data: trs } = await admin
      .from("test_requests")
      .select(
        `
        id, status, released_at, visit_id,
        services ( name, code ),
        visits ( visit_number, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", resourceIds)
      .returns<TestRequestRow[]>();
    for (const tr of trs ?? []) trById.set(tr.id, tr);
  }

  // Staff names for the "Undone by" column.
  const actorIds = Array.from(
    new Set(
      rows
        .filter((r) => r.actor_type === "staff")
        .map((r) => r.actor_id)
        .filter((v): v is string => !!v),
    ),
  );
  const staffNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", actorIds);
    for (const s of staff ?? []) staffNameById.set(s.id, s.full_name);
  }

  const staffUndos = rows.filter((r) => r.actor_type === "staff");
  const stillUnreleased = rows.filter(
    (r) => trById.get(r.resource_id ?? "")?.status === "ready_for_release",
  ).length;
  const reReleased = rows.filter(
    (r) => trById.get(r.resource_id ?? "")?.status === "released",
  ).length;
  const viewedBeforeUndo = staffUndos.filter(
    (r) => Number(asRecord(r.metadata).viewed_count ?? 0) > 0,
  ).length;

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
          Undone releases
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Every result release that was withdrawn — who undid it, why, whether
          the patient had already seen it, and what has happened to the result
          since (RA 10173 oversight). Cascade rows are the system flipping a
          package header back after its component was undone.
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
            Undone from
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
          label="Undo events"
          value={String(rows.length)}
          hint={`${staffUndos.length} by staff · ${rows.length - staffUndos.length} cascade — ${start} → ${end}`}
        />
        <SummaryTile
          label="Still unreleased"
          value={String(stillUnreleased)}
          hint="Pulled and not re-released yet"
          tone={stillUnreleased > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Re-released"
          value={String(reReleased)}
          hint="Corrected and released again"
        />
        <SummaryTile
          label="Viewed before undo"
          value={String(viewedBeforeUndo)}
          hint="Patient had already opened the result"
          tone={viewedBeforeUndo > 0 ? "warn" : "ok"}
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
            No releases were undone in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Patient · Visit</th>
                  <th className="px-4 py-3">Test</th>
                  <th className="px-4 py-3">Undone by</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 text-right">Viewed</th>
                  <th className="px-4 py-3">Current outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const meta = asRecord(r.metadata);
                  const tr = r.resource_id ? trById.get(r.resource_id) : undefined;
                  const svc = pluckOne(tr?.services ?? null);
                  const visit = pluckOne(tr?.visits ?? null);
                  const patient = pluckOne(visit?.patients ?? null);
                  const isCascade = r.actor_type === "system";
                  const viewedCount =
                    meta.viewed_count != null ? Number(meta.viewed_count) : null;
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime.format(new Date(r.created_at))}
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
                        {tr ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            <Link
                              href={`/staff/visits/${tr.visit_id}`}
                              className="hover:underline"
                            >
                              #{visit?.visit_number ?? "—"}
                            </Link>
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {svc ? (
                          <>
                            {svc.name}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {svc.code}
                            </p>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {isCascade ? (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            System (package cascade)
                          </span>
                        ) : (
                          (staffNameById.get(r.actor_id ?? "") ?? "—")
                        )}
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {isCascade
                          ? "Followed its component's undo"
                          : typeof meta.reason === "string"
                            ? meta.reason
                            : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {isCascade ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : viewedCount == null ? (
                          <span
                            className="text-[color:var(--color-brand-text-soft)]"
                            title="Recorded before viewed-count tracking"
                          >
                            —
                          </span>
                        ) : viewedCount > 0 ? (
                          <span className="font-semibold text-amber-700">
                            {viewedCount}×
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {!tr ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : tr.status === "released" ? (
                          <span className="font-semibold text-emerald-700">
                            Re-released{" "}
                            {tr.released_at
                              ? manilaDate.format(new Date(tr.released_at))
                              : ""}
                          </span>
                        ) : tr.status === "ready_for_release" ? (
                          <span className="font-semibold text-amber-700">
                            Still unreleased
                          </span>
                        ) : tr.status === "cancelled" ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            Cancelled
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            {tr.status.replace(/_/g, " ")}
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
