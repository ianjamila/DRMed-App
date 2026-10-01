import { ROUTE_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { manilaDate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import {
  buildDailyCampaignCounts,
  type CampaignResultAppointmentRow,
  type CampaignResultMessageRow,
} from "@/lib/marketing/campaign-results";
import { loadAdSpendCoverage, loadAdSpendRows } from "@/lib/marketing/patient-sources.server";
import { adWindow, AD_WINDOW_DAYS } from "@/lib/marketing/ad-rows";
import type { AdSpendDbRow } from "@/lib/marketing/patient-sources";
import { AdPerformanceDashboard } from "./_components/ad-dashboard";

export const metadata = { title: ROUTE_NAME["/staff/marketing"] };
export const dynamic = "force-dynamic";

// Ad-spend analytics (marketing workspace, tab 1 of 3). The ad rows come from
// the database (ad_spend_daily via ad_spend_rows, 0203) - saved once, shared
// by every admin on any browser; the upload goes through saveAdSpendAction,
// the only write. It also shows what the clinic's OWN records say each campaign produced — bookings and website
// messages — next to the ad platforms' own numbers. That half is computed
// here, server-side, with the RLS-scoped client: only day/campaign COUNTS
// (src/lib/marketing/campaign-results.ts) cross to the client component,
// never names, ids, contact details or raw attribution (RA 10173).
interface SavedAds {
  rows: AdSpendDbRow[];
  /** In-band words about what is NOT shown (older days cut off, or a row ceiling hit). */
  notice: string | null;
  /** The saved rows could not be read: never show sample data in their place. */
  failed: boolean;
  /** First / last saved day, to pre-fill the "remove saved spend" form. */
  coverage: { from: string; to: string } | null;
}

// All saved coverage (both platforms), or its latest 400 days - the RPC refuses
// a longer period - and say so when older days are left out.
async function loadSavedAds(supabase: Awaited<ReturnType<typeof createClient>>): Promise<SavedAds> {
  const coverage = await loadAdSpendCoverage(supabase);
  if (!coverage.ok) return { rows: [], notice: null, failed: true, coverage: null };
  const win = adWindow(coverage.data);
  if (!win) return { rows: [], notice: null, failed: false, coverage: null };
  const loaded = await loadAdSpendRows(supabase, win.from, win.to);
  if (!loaded.ok) return { rows: [], notice: null, failed: true, coverage: { from: win.coverageFrom, to: win.coverageTo } };
  const notices: string[] = [];
  if (win.cutOff) {
    notices.push(
      `Saved spend goes back to ${manilaDate(win.coverageFrom)}, but this screen shows only the latest ${AD_WINDOW_DAYS} days (from ${manilaDate(win.from)}). Older days are saved but not shown here.`,
    );
  }
  if (loaded.data.truncated) {
    const last = loaded.data.rows[loaded.data.rows.length - 1]?.spend_date;
    notices.push(
      `Only the first ${REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} saved ad rows are shown${last ? ` (up to ${manilaDate(last)})` : ""}, so later days are missing and the totals are understated.`,
    );
  }
  return {
    rows: loaded.data.rows,
    notice: notices.length ? notices.join(" ") : null,
    failed: false,
    coverage: { from: win.coverageFrom, to: win.coverageTo },
  };
}

export default async function MarketingAdPerformancePage() {
  await requireAdminStaff();

  const todayISO = todayManilaISODate();
  const fromISO = shiftISODate(todayISO, -400);
  const { fromIso } = manilaRangeUtc(fromISO, todayISO);
  const supabase = await createClient();

  const [
    { rows: apptRows, truncated: apptTruncated },
    { rows: msgRows, truncated: msgTruncated },
    savedAds,
  ] = await Promise.all([
    fetchAllRows<CampaignResultAppointmentRow>(
      (rFrom, rTo) => {
        let q = supabase
          .from("appointments")
          .select("id, booking_group_id, status, attribution, created_at");
        if (fromIso) q = q.gte("created_at", fromIso);
        return q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(rFrom, rTo)
          .returns<CampaignResultAppointmentRow[]>();
      },
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<CampaignResultMessageRow>(
      (rFrom, rTo) => {
        let q = supabase.from("contact_messages").select("id, kind, status, attribution, created_at");
        if (fromIso) q = q.gte("created_at", fromIso);
        return q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(rFrom, rTo)
          .returns<CampaignResultMessageRow[]>();
      },
      REPORT_EXPORT_MAX_ROWS,
    ),
    loadSavedAds(supabase),
  ]);

  const dailyCampaignCounts = buildDailyCampaignCounts(apptRows, msgRows);
  const campaignResultsTruncated = apptTruncated || msgTruncated;

  return (
    <AdPerformanceDashboard
      dailyCampaignCounts={dailyCampaignCounts}
      campaignResultsTruncated={campaignResultsTruncated}
      savedRows={savedAds.rows}
      savedNotice={savedAds.notice}
      savedLoadFailed={savedAds.failed}
      savedCoverage={savedAds.coverage}
    />
  );
}
