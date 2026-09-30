import Link from "next/link";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { manilaDate, todayManilaISODate } from "@/lib/dates/manila";
import { firstParam, PATIENT_SOURCES_MIN_DATE, periodHref, resolvePeriod } from "@/lib/marketing/period";
import { channelLabel } from "@/lib/marketing/patient-sources";
import { loadPeoplePage, type PeopleQuery } from "@/lib/marketing/patient-sources.server";
import { PeriodControls } from "../../_components/period-controls";

export const metadata = { title: ROUTE_NAME["/staff/marketing/patients/people"] };
export const dynamic = "force-dynamic";

const PATHNAME = "/staff/marketing/patients/people";
const PAGE = 50;
const MODE_TITLE = { new: "New customers", returning: "Returning, first time in our records", served: "All customers served" } as const;

export default async function PatientSourcesPeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireAdminStaff();
  const sp = await searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: firstParam(sp.from), to: firstParam(sp.to) }, todayISO, { min: PATIENT_SOURCES_MIN_DATE });
  const rawMode = firstParam(sp.mode);
  const mode: PeopleQuery["mode"] = rawMode === "served" || rawMode === "returning" ? rawMode : "new";
  const channel = firstParam(sp.channel) || null;
  const page = Math.max(1, Number.parseInt(firstParam(sp.page) ?? "1", 10) || 1);
  const params = { from: period.from, to: period.to, mode, channel: channel ?? undefined, page: String(page) };
  const supabase = await createClient();
  const q: PeopleQuery = { from: period.from, to: period.to, mode, channel };
  const res = await loadPeoplePage(supabase, q, PAGE, (page - 1) * PAGE);

  if (res.ok) {
    // RA 10173: a list of names is a disclosure. Counts and filters only, no names.
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: staff.user_id,
      actor_type: "staff",
      action: "patient_sources.viewed",
      resource_type: "report",
      metadata: { from: period.from, to: period.to, mode, channel, page, shown: res.data.rows.length, total: res.data.total },
      ip_address: ip,
      user_agent: ua,
    });
  }

  const title = `${MODE_TITLE[mode]}${channel ? ` — ${channelLabel(channel)}` : ""}`;
  return (
    <div>
      <PageHeader eyebrow={SECTION_NAME["/staff/marketing"]} title={ROUTE_NAME["/staff/marketing/patients/people"]} subtitle={title} />
      <p className="mb-3 text-sm">
        <Link className="underline" href={periodHref("/staff/marketing/patients", { from: period.from, to: period.to }, {})}>
          ← Back to Patient Sources
        </Link>{" "}
        ·{" "}
        <a className="underline" href={periodHref("/api/admin/reports/patient-sources-people.csv", { from: period.from, to: period.to, mode, channel: channel ?? undefined }, {})}>
          Download CSV
        </a>
      </p>
      <PeriodControls pathname={PATHNAME} todayISO={todayISO} from={period.from} to={period.to}
        presetKey={period.presetKey} error={period.error} params={params} min={PATIENT_SOURCES_MIN_DATE} />
      {!res.ok ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">{res.message}</p>
      ) : (
        <>
          <Panel className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">DRM-ID</th>
                  <th className="px-4 py-3">Record</th>
                </tr>
              </thead>
              <tbody>
                {res.data.rows.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-[color:var(--color-brand-text-soft)]">
                    {res.data.total > 0 ? (
                      <>This page is past the end of the list. <Link className="underline" href={periodHref(PATHNAME, params, { page: "1" })}>Go to page 1</Link></>
                    ) : "Nobody here for this period."}
                  </td></tr>
                ) : (
                  res.data.rows.map((r) => (
                    <tr key={r.identity} className="border-t">
                      <td className="px-4 py-3">{manilaDate(r.first_date)}</td>
                      <td className="px-4 py-3">
                        {r.patient_id ? <Link className="underline" href={`/staff/patients/${r.patient_id}`}>{r.display_name}</Link> : r.display_name}
                      </td>
                      <td className="px-4 py-3">{r.drm_id ?? "—"}</td>
                      <td className="px-4 py-3">{r.identity_kind === "confirmed" ? "Patient record" : "Name in the sheet (unconfirmed)"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Panel>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span>
              {res.data.rows.length === 0 ? "0" : `${(page - 1) * PAGE + 1}–${(page - 1) * PAGE + res.data.rows.length}`} of {res.data.total.toLocaleString("en-PH")}
            </span>
            <span className="flex gap-3">
              {page > 1 ? <Link className="underline" href={periodHref(PATHNAME, params, { page: String(page - 1) })}>← Previous</Link> : null}
              {page * PAGE < res.data.total ? <Link className="underline" href={periodHref(PATHNAME, params, { page: String(page + 1) })}>Next →</Link> : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
