import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { ALL_SECTIONS } from "@/lib/auth/role-sections";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Lab TAT analytics — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string; section?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ReleasedRow {
  id: string;
  requested_at: string;
  released_at: string | null;
  status: string;
  services:
    | { name: string; section: string | null; turnaround_hours: number | null }
    | { name: string; section: string | null; turnaround_hours: number | null }[]
    | null;
  patients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  visits: { visit_number: string } | { visit_number: string }[] | null;
}

interface SectionMetric {
  section: string;
  totalReleased: number;
  pending: number;
  tatSamples: number[];
  slaBreaches: number;
  worstTatHours: number;
  worstTatRequestId: string | null;
}

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function formatHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24);
  const rem = Math.round(h - d * 24);
  return `${d}d ${rem}h`;
}

const SECTION_LABEL: Record<string, string> = {
  chemistry: "Chemistry",
  hematology: "Hematology",
  immunology: "Immunology",
  urinalysis: "Urinalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  send_out: "Send-out",
  consultation: "Consultation",
  procedure: "Procedure",
  vaccine: "Vaccine",
  home_service: "Home service",
  package: "Package",
};

export default async function LabTatPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const defaultStart = new Date(`${todayISO}T00:00:00+08:00`);
  defaultStart.setDate(defaultStart.getDate() - 30);
  const defaultStartISO = defaultStart.toISOString().slice(0, 10);

  const start = sp.start && DATE_RE.test(sp.start) ? sp.start : defaultStartISO;
  const end = sp.end && DATE_RE.test(sp.end) ? sp.end : todayISO;
  const sectionFilter = sp.section && ALL_SECTIONS.includes(sp.section as (typeof ALL_SECTIONS)[number])
    ? sp.section
    : "";

  const admin = createAdminClient();

  // Released test_requests in the window (for TAT samples).
  let releasedQ = admin
    .from("test_requests")
    .select(
      `
      id, requested_at, released_at, status,
      services!inner ( name, section, turnaround_hours ),
      patients ( first_name, last_name ),
      visits ( visit_number )
    `,
    )
    .eq("status", "released")
    .gte("released_at", `${start}T00:00:00+08:00`)
    .lte("released_at", `${end}T23:59:59+08:00`);
  if (sectionFilter) {
    releasedQ = releasedQ.eq("services.section", sectionFilter);
  }
  const { data: released } = await releasedQ.returns<ReleasedRow[]>();

  // Pending = requested but not yet released, regardless of date window (we
  // want to know what's currently stuck).
  let pendingQ = admin
    .from("test_requests")
    .select("id, services!inner ( section )", { count: "exact", head: true })
    .in("status", ["requested", "in_progress", "result_uploaded", "ready_for_release"]);
  if (sectionFilter) {
    pendingQ = pendingQ.eq("services.section", sectionFilter);
  }
  const { count: pendingTotal } = await pendingQ;

  const metricsBySection = new Map<string, SectionMetric>();

  function ensureSection(section: string): SectionMetric {
    let m = metricsBySection.get(section);
    if (!m) {
      m = {
        section,
        totalReleased: 0,
        pending: 0,
        tatSamples: [],
        slaBreaches: 0,
        worstTatHours: 0,
        worstTatRequestId: null,
      };
      metricsBySection.set(section, m);
    }
    return m;
  }

  const slaBreachRows: {
    requestId: string;
    section: string;
    serviceName: string;
    patientName: string;
    visitNumber: string;
    tatHours: number;
    slaHours: number | null;
    releasedAt: string;
  }[] = [];

  for (const tr of released ?? []) {
    if (!tr.released_at) continue;
    const svc = pluckOne(tr.services);
    if (!svc) continue;
    const sec = svc.section ?? "(unset)";
    const m = ensureSection(sec);
    m.totalReleased += 1;

    const tatMs = Date.parse(tr.released_at) - Date.parse(tr.requested_at);
    const tatHours = tatMs / 3_600_000;
    // Filter outliers > 60 days as garbage data.
    if (tatHours >= 0 && tatHours < 24 * 60) {
      m.tatSamples.push(tatHours);
      if (tatHours > m.worstTatHours) {
        m.worstTatHours = tatHours;
        m.worstTatRequestId = tr.id;
      }
      const slaHours = svc.turnaround_hours;
      if (slaHours !== null && slaHours !== undefined && tatHours > slaHours) {
        m.slaBreaches += 1;
        if (slaBreachRows.length < 20) {
          const p = pluckOne(tr.patients);
          const v = pluckOne(tr.visits);
          slaBreachRows.push({
            requestId: tr.id,
            section: sec,
            serviceName: svc.name,
            patientName: p ? `${p.last_name}, ${p.first_name}` : "Walk-in",
            visitNumber: v?.visit_number ?? "—",
            tatHours,
            slaHours,
            releasedAt: tr.released_at,
          });
        }
      }
    }
  }

  const rows = Array.from(metricsBySection.values()).sort(
    (a, b) => b.totalReleased - a.totalReleased,
  );

  // Aggregate totals
  const allSamples = rows.flatMap((r) => r.tatSamples);
  const overallMedian = median(allSamples);
  const overallP95 = percentile(allSamples, 0.95);
  const totalReleased = rows.reduce((s, r) => s + r.totalReleased, 0);
  const totalBreaches = rows.reduce((s, r) => s + r.slaBreaches, 0);
  const overallBreachPct =
    totalReleased > 0 ? Math.round((totalBreaches / totalReleased) * 100) : 0;

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
          Lab TAT analytics
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Per-section turnaround time for released test requests in the
          selected window. TAT is computed from{" "}
          <code>released_at − requested_at</code>; samples beyond 60 days are
          excluded as outliers. SLA breaches use{" "}
          <code>services.turnaround_hours</code>.
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
            Released from
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
            htmlFor="section"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Section
          </label>
          <select
            id="section"
            name="section"
            defaultValue={sectionFilter}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          >
            <option value="">All sections</option>
            {ALL_SECTIONS.map((s) => (
              <option key={s} value={s}>
                {SECTION_LABEL[s] ?? s}
              </option>
            ))}
          </select>
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
          label="Released"
          value={String(totalReleased)}
          hint={`In ${start} → ${end}`}
        />
        <SummaryTile
          label="Pending"
          value={String(pendingTotal ?? 0)}
          hint="Currently unreleased (any age)"
          tone={(pendingTotal ?? 0) > 0 ? "warn" : "ok"}
        />
        <SummaryTile
          label="Median TAT"
          value={formatHours(overallMedian)}
          hint={`P95: ${formatHours(overallP95)}`}
        />
        <SummaryTile
          label="SLA breaches"
          value={String(totalBreaches)}
          hint={`${overallBreachPct}% of released`}
          tone={totalBreaches > 0 ? "warn" : "ok"}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No released tests in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Section</th>
                  <th className="px-4 py-3 text-right">Released</th>
                  <th className="px-4 py-3 text-right">Median TAT</th>
                  <th className="px-4 py-3 text-right">P95 TAT</th>
                  <th className="px-4 py-3 text-right">Worst</th>
                  <th className="px-4 py-3 text-right">SLA breach</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const med = median(r.tatSamples);
                  const p95 = percentile(r.tatSamples, 0.95);
                  const breachPct =
                    r.totalReleased > 0
                      ? Math.round((r.slaBreaches / r.totalReleased) * 100)
                      : 0;
                  return (
                    <tr key={r.section}>
                      <td className="px-4 py-3 font-medium text-[color:var(--color-brand-navy)]">
                        {SECTION_LABEL[r.section] ?? r.section}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.totalReleased}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {formatHours(med)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {formatHours(p95)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {r.worstTatRequestId ? (
                          <Link
                            href={`/staff/queue/${r.worstTatRequestId}`}
                            className="hover:underline"
                          >
                            {formatHours(r.worstTatHours)}
                          </Link>
                        ) : (
                          formatHours(r.worstTatHours)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.slaBreaches > 0 ? (
                          <span className="text-amber-700">
                            {r.slaBreaches} ({breachPct}%)
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            0
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
      </section>

      {slaBreachRows.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
            SLA breach detail (top 20)
          </h2>
          <Panel className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <th className="px-4 py-3">Section</th>
                    <th className="px-4 py-3">Service</th>
                    <th className="px-4 py-3">Patient · Visit</th>
                    <th className="px-4 py-3 text-right">TAT</th>
                    <th className="px-4 py-3 text-right">SLA</th>
                    <th className="px-4 py-3 text-right">Over</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {slaBreachRows
                    .sort((a, b) => b.tatHours - a.tatHours)
                    .map((b) => (
                      <tr key={b.requestId}>
                        <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                          {SECTION_LABEL[b.section] ?? b.section}
                        </td>
                        <td className="px-4 py-2">{b.serviceName}</td>
                        <td className="px-4 py-2">
                          {b.patientName}{" "}
                          <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            #{b.visitNumber}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">
                          {formatHours(b.tatHours)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                          {b.slaHours ? `${b.slaHours}h` : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-red-700">
                          {b.slaHours
                            ? `+${formatHours(b.tatHours - b.slaHours)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>
      ) : null}
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
