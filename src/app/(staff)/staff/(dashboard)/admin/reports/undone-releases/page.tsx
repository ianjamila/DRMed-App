import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import {
  loadUndoneReleases,
  parseUndoneReleasesParams,
  undoneReleasesCsvHref,
} from "@/lib/reports/undone-releases";

export const metadata = { title: "Undone releases — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

// Hard cap so a wide-open range can't pull the whole audit log into one
// render (same policy as the staff-advances report).
const MAX_ROWS = 500;

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
  const params = parseUndoneReleasesParams(sp, todayISO);
  const { start, end } = params;

  const admin = createAdminClient();
  const { entries, summary, truncated: capped } = await loadUndoneReleases(admin, params, MAX_ROWS);
  const rows = entries;
  const { staffUndos, stillUnreleased, reReleased, viewedBeforeUndo } = summary;

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
        <ExportCsvLink href={undoneReleasesCsvHref(params)} />
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Undo events"
          value={String(rows.length)}
          hint={`${staffUndos} by staff · ${rows.length - staffUndos} cascade — ${start} → ${end}`}
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
                {rows.map((e) => {
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime.format(new Date(e.createdAt))}
                      </td>
                      <td className="px-4 py-3">
                        {e.patient ? (
                          <>
                            {e.patient.last_name}, {e.patient.first_name}{" "}
                            <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                              {e.patient.drm_id}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                        {e.visitId ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            <Link
                              href={`/staff/visits/${e.visitId}`}
                              className="hover:underline"
                            >
                              #{e.visitNumber ?? "—"}
                            </Link>
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {e.serviceName ? (
                          <>
                            {e.serviceName}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {e.serviceCode}
                            </p>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.isCascade ? (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            System (package cascade)
                          </span>
                        ) : (
                          (e.actorName ?? "—")
                        )}
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {e.isCascade
                          ? "Followed its component's undo"
                          : (e.reason ?? "—")}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {e.isCascade ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : e.viewedCount == null ? (
                          <span
                            className="text-[color:var(--color-brand-text-soft)]"
                            title="Recorded before viewed-count tracking"
                          >
                            —
                          </span>
                        ) : e.viewedCount > 0 ? (
                          <span className="font-semibold text-amber-700">
                            {e.viewedCount}×
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {!e.currentStatus ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        ) : e.currentStatus === "released" ? (
                          <span className="font-semibold text-emerald-700">
                            Re-released{" "}
                            {e.releasedAt
                              ? manilaDate.format(new Date(e.releasedAt))
                              : ""}
                          </span>
                        ) : e.currentStatus === "ready_for_release" ? (
                          <span className="font-semibold text-amber-700">
                            Still unreleased
                          </span>
                        ) : e.currentStatus === "cancelled" ? (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            Cancelled
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            {e.currentStatus.replace(/_/g, " ")}
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
