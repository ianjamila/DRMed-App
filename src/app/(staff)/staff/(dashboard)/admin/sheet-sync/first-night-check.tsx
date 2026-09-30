import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Panel } from "@/components/ui/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { manilaDate, manilaDateTime, todayManilaISODate } from "@/lib/dates/manila";
import {
  cliCommand, DEFAULT_THRESHOLD, MAX_THRESHOLD, PANEL_MAX_DAYS, parseCheckParams,
  type CheckReport, type Counts, type Verdict,
} from "@/lib/marketing/first-night-check";
import { runFirstNightCheck } from "@/lib/marketing/first-night-check.server";
import { formatNewCounts } from "@/lib/marketing/patient-sources";

const BASE_PATH = "/staff/admin/sheet-sync";

interface FormValues { from: string; to: string; threshold: string }

/**
 * Admin › Sheet Sync › First-night check. A plain visit only shows the form —
 * the (slow, ~3 calls per day) check runs when the form is submitted
 * (`run=1`), so the result is a linkable address and costs nothing to open.
 */
export async function FirstNightCheck({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const today = todayManilaISODate();
  const parsed = parseCheckParams(
    { from: searchParams.from, to: searchParams.to, threshold: searchParams.threshold },
    { maxDays: PANEL_MAX_DAYS, today },
  );
  // The form echoes what was typed; with nothing typed it shows the defaults (last 7 days).
  const typed = Boolean(searchParams.from || searchParams.to || searchParams.threshold);
  const shown = parsed.ok ? parsed.params : null;
  const form: FormValues = typed || !shown
    ? { from: searchParams.from ?? "", to: searchParams.to ?? "", threshold: searchParams.threshold ?? String(DEFAULT_THRESHOLD) }
    : { from: shown.from, to: shown.to, threshold: String(shown.threshold) };
  if (searchParams.run !== "1") return <FirstNightCheckView form={form} paramErrors={[]} result={null} />;
  if (!parsed.ok) return <FirstNightCheckView form={form} paramErrors={parsed.errors} result={null} />;

  const supabase = await createClient();
  let result: Awaited<ReturnType<typeof runFirstNightCheck>> | null = null;
  try {
    result = await runFirstNightCheck(supabase, parsed.params);
  } catch (e) {
    console.error("first-night check failed", e);
  }
  if (!result) {
    return (
      <FirstNightCheckView
        form={form}
        paramErrors={["The check stopped unexpectedly. Try again; if it keeps happening, tell the developer."]}
        result={null}
      />
    );
  }
  return <FirstNightCheckView form={form} paramErrors={[]} result={result} />;
}

const VERDICT_VARIANT: Record<Verdict, "success" | "warning" | "destructive"> = {
  pass: "success", spike: "warning", mismatch: "destructive", error: "destructive",
};

const TH = "px-3 py-2";
const HEAD =
  "border-b border-[color:var(--color-brand-bg-mid)] text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]";
const SOFT = "text-xs text-[color:var(--color-brand-text-soft)]";

const cell = (c: Counts | null) => (c ? formatNewCounts(c.confirmed, c.unconfirmed) : "Unknown");

export function FirstNightCheckView({
  form, paramErrors, result,
}: {
  form: FormValues;
  paramErrors: string[];
  result: { report: CheckReport; durationMs: number } | null;
}) {
  const today = todayManilaISODate();
  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <p className="font-bold text-[color:var(--color-brand-navy)]">First-night check</p>
        <p className={`mt-1 ${SOFT}`}>
          Proves every screen that shows “New patients” agrees, and flags any day whose count jumps — the sign of imported
          records being counted as new. Read-only; up to {PANEL_MAX_DAYS} days at a time.
        </p>
        <form method="get" action={BASE_PATH} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="view" value="check" />
          <input type="hidden" name="run" value="1" />
          <label className="text-sm">
            <span className="block font-semibold">From</span>
            <input type="date" name="from" defaultValue={form.from} max={today}
              className="mt-1 min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2" />
          </label>
          <label className="text-sm">
            <span className="block font-semibold">To</span>
            <input type="date" name="to" defaultValue={form.to} max={today}
              className="mt-1 min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2" />
          </label>
          <label className="text-sm">
            <span className="block font-semibold">Spike threshold</span>
            <input type="number" name="threshold" defaultValue={form.threshold} min={1} max={MAX_THRESHOLD} step={1}
              className="mt-1 min-h-11 w-28 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2" />
          </label>
          <button type="submit"
            className="min-h-11 rounded-md bg-[color:var(--color-brand-navy)] px-4 text-sm font-semibold text-white">
            Run check
          </button>
        </form>
        <p className={`mt-2 ${SOFT}`}>
          A “spike” is a day with more new patients than the threshold. A normal day is a handful.
        </p>
      </Panel>

      {paramErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Can&apos;t run the check yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {paramErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {result && <Report report={result.report} durationMs={result.durationMs} />}
    </div>
  );
}

function Report({ report: r, durationMs }: { report: CheckReport; durationMs: number }) {
  const { from, to, threshold } = r.params;
  return (
    <>
      <Alert variant={VERDICT_VARIANT[r.verdict]}>
        <AlertTitle className="text-base font-bold">{r.headline}</AlertTitle>
        <AlertDescription>
          <p>{r.advice}</p>
          {r.mismatches.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {r.mismatches.map((m, i) => <li key={`${m.kind}-${m.date ?? "range"}-${i}`}>{m.message}</li>)}
            </ul>
          )}
          {r.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {r.errors.map((e, i) => (
                <li key={`${e.what}-${e.date ?? ""}-${i}`}>
                  {e.what}{e.date ? ` (${manilaDate(e.date)})` : ""}: {e.message}
                </li>
              ))}
            </ul>
          )}
          {r.spikes.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {r.spikes.map((s) => <li key={s.date}>{manilaDate(s.date)}: {s.count.toLocaleString("en-PH")} new patients</li>)}
            </ul>
          )}
        </AlertDescription>
      </Alert>

      <p className={SOFT}>
        {manilaDate(from)} to {manilaDate(to)} · {r.days.length} day{r.days.length === 1 ? "" : "s"} · a normal day has{" "}
        {r.stats.median.toLocaleString("en-PH")} (typical) and the busiest had {r.stats.max.toLocaleString("en-PH")}
        {r.stats.maxDate ? ` on ${manilaDate(r.stats.maxDate)}` : ""} · spike threshold {threshold.toLocaleString("en-PH")} ·
        took {(durationMs / 1000).toFixed(1)}s
      </p>

      <section>
        <h2 className="mb-2 font-bold text-[color:var(--color-brand-navy)]">Whole range — every screen</h2>
        <Panel className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className={HEAD}>
              <tr><th className={TH}>Screen</th><th className={TH}>New patients</th><th className={TH}>Agrees with Patient Sources</th></tr>
            </thead>
            <tbody>
              {r.totals.map((t) => (
                <tr key={t.key} className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0">
                  <td className={`${TH} font-semibold`}>{t.label}</td>
                  <td className={TH}>{t.text ?? "Unknown"}</td>
                  <td className={TH}>
                    {t.agrees === null ? (t.key === "patient_sources" ? "—" : "Not checked") : t.agrees
                      ? <span className="text-emerald-700">Yes</span>
                      : <span className="font-semibold text-red-600">No</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      <section>
        <h2 className="mb-2 font-bold text-[color:var(--color-brand-navy)]">Day by day</h2>
        <Panel className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className={HEAD}>
              <tr>
                <th className={TH}>Date</th>
                <th className={TH}>Patient Sources</th>
                <th className={TH}>Chart</th>
                <th className={TH}>Dashboard tile</th>
                <th className={TH}>Records created (app / imported)</th>
                <th className={TH}>Flag</th>
              </tr>
            </thead>
            <tbody>
              {r.days.map((d) => (
                <tr key={d.date}
                  className={`border-b border-[color:var(--color-brand-bg-mid)] last:border-0 ${
                    d.mismatch ? "bg-red-50" : d.spike ? "bg-amber-50" : ""}`}>
                  <td className={`${TH} font-semibold`}>{manilaDate(d.date)}</td>
                  <td className={TH}>{cell(d.summary)}</td>
                  <td className={TH}>{cell(d.chart)}</td>
                  <td className={TH}>{cell(d.tile)}</td>
                  <td className={TH}>{d.created ? `${d.created.app.toLocaleString("en-PH")} / ${d.created.imported.toLocaleString("en-PH")}` : "Unknown"}</td>
                  <td className={TH}>
                    {d.mismatch && <span className="font-semibold text-red-600">Screens differ</span>}
                    {d.mismatch && d.spike && " · "}
                    {d.spike && <span className="font-semibold text-amber-700">Above {threshold.toLocaleString("en-PH")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <p className={`mt-2 ${SOFT}`}>
          Each count is confirmed · unconfirmed New patients. “Records created” is context, not judged: patient records
          made that day — by reception (app) or by an import such as Sheet Sync. Many imported records with New patients
          staying low is the healthy result.
        </p>
      </section>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link className="font-semibold text-cyan-700 hover:underline" href={`/staff/marketing/patients?from=${from}&to=${to}`}>
          Open Patient Sources for this period
        </Link>
        <Link className="font-semibold text-cyan-700 hover:underline" href={`/staff/marketing/sources?from=${from}&to=${to}`}>
          Open Booking Sources for this period
        </Link>
      </div>

      {r.sync && (
        <p className={SOFT}>
          Sheet sync is {r.sync.paused ? "paused" : r.sync.paused === false ? "on" : "in an unknown state"}
          {" · "}last synced {r.sync.lastSyncedAt ? manilaDateTime(r.sync.lastSyncedAt) : "never"}
          {" · "}last run {r.sync.lastRunStatus ?? "none yet"}
          {" · "}{r.sync.undatedRegistrations.toLocaleString("en-PH")} people registered with no date and no recorded visit —
          not on any day.
        </p>
      )}

      <p className={SOFT}>
        The same check from a terminal: <code className="rounded bg-[color:var(--color-brand-bg)] px-1">{cliCommand(r.params)}</code>
      </p>
    </>
  );
}
