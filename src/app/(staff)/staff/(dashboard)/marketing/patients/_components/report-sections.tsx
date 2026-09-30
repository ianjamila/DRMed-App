import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { manilaDate } from "@/lib/dates/manila";
import {
  channelLabel, type ChannelTableRow, type CostPerNew, type OverlapRow, type ReferrerRow, type RevenueRow,
} from "@/lib/marketing/patient-sources";
import type { SpendCoverageRow } from "@/lib/marketing/patient-sources.server";
import { formatPeso } from "../../../_dashboards/_components/format";
import { AdSpendRemoveForm } from "./ad-spend-remove-form";

const th = "px-4 py-3";
const thead = "bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]";
const h2 = "mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]";
const note = "mt-2 text-xs text-[color:var(--color-brand-text-soft)]";
const empty = (cols: number, text: string) => (
  <tr><td colSpan={cols} className="px-4 py-6 text-center text-[color:var(--color-brand-text-soft)]">{text}</td></tr>
);

export function ChannelTableSection({ rows, peopleHref, modeLabel }: {
  rows: ChannelTableRow[];
  peopleHref: (channel: string) => string;
  modeLabel: string;
}) {
  return (
    <section className="mt-6">
      <h2 className={h2}>{modeLabel} by channel</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Channel</th>
              <th className={`${th} text-right`}>Confirmed</th>
              <th className={`${th} text-right`}>Unconfirmed</th>
              <th className={`${th} text-right`}>Share</th>
              <th className={`${th} text-right`}>vs previous period</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? empty(5, "Nobody in this period.")
              : rows.map((r) => (
                  <tr key={r.channel} className="border-t">
                    <td className={th}><Link className="underline" href={peopleHref(r.channel)}>{r.label}</Link></td>
                    <td className={`${th} text-right`}>{r.confirmed.toLocaleString("en-PH")}</td>
                    <td className={`${th} text-right`}>{r.unconfirmed.toLocaleString("en-PH")}</td>
                    <td className={`${th} text-right`}>{Math.round(r.share * 100)}%</td>
                    <td className={`${th} text-right`}>
                      {r.change > 0 ? `+${r.change}` : r.change} (was {r.previousTotal})
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Unconfirmed = a name in the reception sheet not yet matched to a patient record. Click a channel to see the people.
      </p>
    </section>
  );
}

export function CostSection({ costs, coverage, from, to }: {
  costs: CostPerNew[] | null;
  coverage: SpendCoverageRow[] | null;
  from: string;
  to: string;
}) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Cost per new patient</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Ads</th>
              <th className={`${th} text-right`}>Spend</th>
              <th className={`${th} text-right`}>Days with spend</th>
              <th className={`${th} text-right`}>New customers (confirmed + unconfirmed)</th>
              <th className={`${th} text-right`}>Cost per new patient</th>
            </tr>
          </thead>
          <tbody>
            {costs === null
              ? empty(5, "Couldn't load saved ad spend — reload the page.")
              : costs.every((c) => c.days === 0)
                ? empty(5, "No ad spend saved for this period. Upload a daily export on Ad Performance.")
                : costs.map((c) => (
                    <tr key={c.platform} className="border-t">
                      <td className={th}>{c.label}</td>
                      <td className={`${th} text-right`}>{formatPeso(c.spendPhp)}</td>
                      <td className={`${th} text-right`}>{c.days}</td>
                      <td className={`${th} text-right`}>{c.newConfirmed} + {c.newUnconfirmed}</td>
                      <td className={`${th} text-right`}>{c.costPerNewPhp === null ? "—" : formatPeso(c.costPerNewPhp)}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Spend ÷ new customers whose channel is Facebook (Meta) or Google, counted only on days that have saved spend —
        days without spend are left out. Instagram and TikTok are not counted against Meta spend.
      </p>
      {coverage && coverage.length > 0 ? (
        <p className={note}>
          Saved spend on file:{" "}
          {coverage.map((c) => `${c.platform === "meta" ? "Meta" : "Google"} ${manilaDate(c.first_date)} – ${manilaDate(c.last_date)} (${c.days} days, ${formatPeso(Number(c.total_php))})`).join(" · ")}
        </p>
      ) : null}
      <AdSpendRemoveForm defaultFrom={from} defaultTo={to} />
    </section>
  );
}

export function RevenueSection({ revenue, overlaps }: {
  revenue: RevenueRow[] | null;
  /** null = the double-entry check failed to load (never shown as "none"). */
  overlaps: { rows: OverlapRow[]; truncated: boolean } | null;
}) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Channel revenue — billed (clinic share)</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Channel</th>
              <th className={`${th} text-right`}>Confirmed</th>
              <th className={`${th} text-right`}>Unconfirmed</th>
            </tr>
          </thead>
          <tbody>
            {revenue === null
              ? empty(3, "Couldn't load revenue — reload the page.")
              : revenue.length === 0
                ? empty(3, "No billed services in this period.")
                : revenue.map((r) => (
                    <tr key={r.channel} className="border-t">
                      <td className={th}>{channelLabel(r.channel)}</td>
                      <td className={`${th} text-right`}>{formatPeso(Number(r.confirmed_php))}</td>
                      <td className={`${th} text-right`}>{formatPeso(Number(r.unconfirmed_php))}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        What was billed on the service date — app lab lines at their final price, consultations at the clinic fee — not
        what was collected.
      </p>
      {overlaps === null ? (
        <p className="mt-3 text-sm text-amber-700" role="alert">
          Couldn&apos;t load the double-entry check. The revenue above still leaves out sheet lines that match an app
          visit on the same day, but the list of them is unknown — reload the page.
        </p>
      ) : null}
      {overlaps && overlaps.rows.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold">
            Possible double entry ({overlaps.rows.length.toLocaleString("en-PH")}{overlaps.truncated ? "+" : ""})
          </summary>
          {overlaps.truncated ? (
            <p className="mt-1 text-sm text-amber-700">
              Only the first {overlaps.rows.length.toLocaleString("en-PH")} are listed — pick a shorter period to see them all.
            </p>
          ) : null}
          <p className={note}>
            The same patient on the same day has an app visit and sheet lines. The sheet amount is left out of the revenue
            above; check which record is right.
          </p>
          <Panel className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={thead}>
                <tr>
                  <th className={th}>DRM-ID</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>App amount</th>
                  <th className={`${th} text-right`}>Sheet amount</th>
                </tr>
              </thead>
              <tbody>
                {overlaps.rows.map((o) => (
                  <tr key={`${o.patient_id}|${o.service_date}`} className="border-t">
                    <td className={th}><Link className="underline" href={`/staff/patients/${o.patient_id}`}>{o.drm_id}</Link></td>
                    <td className={th}>{manilaDate(o.service_date)}</td>
                    <td className={`${th} text-right`}>{formatPeso(Number(o.app_php))}</td>
                    <td className={`${th} text-right`}>{formatPeso(Number(o.sheet_php))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </details>
      ) : null}
    </section>
  );
}

export function ReferrersSection({ rows }: { rows: ReferrerRow[] | null }) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Top referring doctors</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Doctor (as most often written)</th>
              <th className={`${th} text-right`}>New — confirmed</th>
              <th className={`${th} text-right`}>New — unconfirmed</th>
            </tr>
          </thead>
          <tbody>
            {rows === null
              ? empty(3, "Couldn't load referring doctors — reload the page.")
              : rows.length === 0
                ? empty(3, "No new customer in this period named a referring doctor.")
                : rows.map((r) => (
                    <tr key={r.doctor_label} className="border-t">
                      <td className={th}>{r.doctor_label}</td>
                      <td className={`${th} text-right`}>{r.new_confirmed}</td>
                      <td className={`${th} text-right`}>{r.new_unconfirmed}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Spellings are grouped ignoring “Dr.”, “Dra.”, “Doc”, capitals and punctuation. Top 20.
      </p>
    </section>
  );
}
