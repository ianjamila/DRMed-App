/**
 * Patient Sources owner email — data gathering. Two report calls (one snapshot per
 * period), read THROUGH the shared loader, plus the saved ad spend read straight
 * from its table. The cron holds the service key, so this module must never call a
 * function that is admin-only inside its body: with the service key that is a
 * refused call, and on prod's current Postgres image a refused call crashes the
 * database. patient-sources-digest.server.test.ts pins that this source names none
 * of them.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { loadPatientSourcesReport } from "@/lib/marketing/patient-sources.server";
import type { PatientSourcesReport, Period, SpendTotalRow } from "./patient-sources";
import {
  aggregateSpend,
  digestPeriods,
  renderPatientSourcesDigest,
  type DigestData,
  type DigestKind,
  type DigestPeriodData,
  type RawSpendRow,
} from "./patient-sources-digest";

type Db = SupabaseClient<Database>;

export type DigestLoad =
  | { ok: true; kind: "data"; data: DigestData }
  | { ok: true; kind: "too_early"; period: Period }
  | { ok: false; message: string };

const periodData = (period: Period, r: PatientSourcesReport): DigestPeriodData => ({
  period,
  summary: r.summary,
  servedByDay: r.series,
  newByDay: r.new_by_day,
  revenue: r.revenue,
  referrers: r.referrers,
});

async function spendCount(admin: Db, range?: Period): Promise<number> {
  let q = admin.from("ad_spend_daily").select("id", { count: "exact", head: true });
  if (range) q = q.gte("spend_date", range.from).lte("spend_date", range.to);
  const { count, error } = await q;
  if (error || count === null) throw new Error(`ad spend count: ${error?.message ?? "no count"}`);
  return count;
}

async function spendRows(admin: Db, range: Period): Promise<RawSpendRow[]> {
  const { rows, truncated } = await fetchAllRows<RawSpendRow>(
    (a, b) =>
      admin
        .from("ad_spend_daily")
        .select("spend_date, platform, spend_php")
        .gte("spend_date", range.from)
        .lte("spend_date", range.to)
        // The table's full unique key (0189 ad_spend_daily_key): a TOTAL order, so .range() paging can
        // neither repeat nor drop a row.
        .order("spend_date")
        .order("platform")
        .order("campaign_key")
        .order("ad_key")
        .range(a, b)
        .returns<RawSpendRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  if (truncated) throw new Error("ad spend: more rows than a digest will read");
  return rows;
}

/**
 * Saved spend per date × platform over `range`. The row count is taken before and
 * after the paging; if it moved (an import landed mid-read) or the rows do not add
 * up to it, read once more; if it still moves, fail — a partial spend read must
 * never become a number in an email.
 */
export async function readSpend(admin: Db, range: Period): Promise<SpendTotalRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await spendCount(admin, range);
    const rows = await spendRows(admin, range);
    const after = await spendCount(admin, range);
    if (before === after && rows.length === after) return aggregateSpend(rows);
  }
  throw new Error("ad spend changed while it was being read");
}

/**
 * Everything one digest needs. `todayISO` is the day the digest is sent (a retry for
 * an earlier period passes the day after that period). Two report calls — one
 * snapshot each — then the spend over [previous.from ?? current.from, current.to].
 */
export async function loadPatientSourcesDigest(
  admin: Db,
  kind: DigestKind,
  todayISO: string,
  now: () => Date = () => new Date(),
): Promise<DigestLoad> {
  const { cur, prev, tooEarly } = digestPeriods(kind, todayISO);
  if (tooEarly) return { ok: true, kind: "too_early", period: cur };

  const reportFor = (p: Period) => loadPatientSourcesReport(admin, { ...p, grain: "day", mode: "served", prev: null });
  const [curRes, prevRes] = await Promise.all([reportFor(cur), prev ? reportFor(prev) : Promise.resolve(null)]);
  if (!curRes.ok) return { ok: false, message: `report: ${curRes.message}` };
  if (prevRes && !prevRes.ok) return { ok: false, message: `previous report: ${prevRes.message}` };

  let spend: SpendTotalRow[];
  let spendEverSaved: boolean;
  try {
    spend = await readSpend(admin, { from: prev?.from ?? cur.from, to: cur.to });
    spendEverSaved = spend.length > 0 || (await spendCount(admin)) > 0;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "ad spend read failed" };
  }

  const readAt = now();
  return {
    ok: true,
    kind: "data",
    data: {
      kind,
      cur: periodData(cur, curRes.data),
      prev: prev && prevRes && prevRes.ok ? periodData(prev, prevRes.data) : null,
      spend,
      spendEverSaved,
      readAt,
    },
  };
}

export type DigestEmailBuild =
  | { ok: true; kind: "email"; period: Period; subject: string; html: string; text: string }
  | { ok: true; kind: "too_early"; period: Period }
  | { ok: false; message: string };

/** Load + render — what the cron, the preview button and `npm run email:preview` all call. */
export async function buildPatientSourcesDigestEmail(
  admin: Db,
  kind: DigestKind,
  todayISO: string,
  appUrl: string,
  now?: () => Date,
): Promise<DigestEmailBuild> {
  const loaded = await loadPatientSourcesDigest(admin, kind, todayISO, now);
  if (!loaded.ok) return loaded;
  if (loaded.kind === "too_early") return loaded;
  return { ok: true, kind: "email", period: loaded.data.cur.period, ...renderPatientSourcesDigest(loaded.data, { appUrl }) };
}
