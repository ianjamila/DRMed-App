import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import {
  deletedEntriesCsvHref,
  loadDeletedEntries,
  parseDeletedEntriesParams,
} from "@/lib/reports/deleted-entries";

export const metadata = { title: "Deleted queue entries — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

// Hard cap so a wide-open range can't pull the whole audit log into one
// render (same policy as the undone-releases report).
const MAX_ROWS = 500;

const manilaDateTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function DeletedEntriesPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const params = parseDeletedEntriesParams(sp, todayISO);
  const { start, end } = params;

  const admin = createAdminClient();
  const { entries, summary, truncated: capped } = await loadDeletedEntries(admin, params, MAX_ROWS);
  const rows = entries;
  const { deleteEvents, restoreEvents, stillDeleted, deletedValue } = summary;

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
        <ExportCsvLink href={deletedEntriesCsvHref(params)} />
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Delete events"
          value={String(deleteEvents)}
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
                {rows.map((e) => {
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime.format(new Date(e.createdAt))}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            e.isDelete
                              ? "bg-red-100 text-red-900"
                              : "bg-emerald-100 text-emerald-900"
                          }`}
                        >
                          {e.isDelete ? "Deleted" : "Restored"}
                        </span>
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
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {e.visitHref ? (
                            <Link href={e.visitHref} className="hover:underline">
                              #{e.visitNumber ?? "—"}
                            </Link>
                          ) : (
                            <>#{e.visitNumber ?? "—"}</>
                          )}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {e.isVisit ? (
                          <>
                            Entire visit
                            {e.activeTestCount != null ? (
                              <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
                                {e.activeTestCount}{" "}
                                {e.activeTestCount === 1 ? "test" : "tests"}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <>
                            {e.serviceName ?? "—"}
                            <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                              {e.serviceCode ?? ""}
                              {e.isPackageHeader ? " · package" : ""}
                            </p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">{e.actorName ?? "—"}</td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {e.reason ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {e.amount != null && e.amount > 0 ? formatPhp(e.amount) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {e.currentlyDeleted ? (
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
