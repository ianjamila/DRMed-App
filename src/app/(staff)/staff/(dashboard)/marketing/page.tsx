import { ROUTE_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import {
  buildDailyCampaignCounts,
  type CampaignResultAppointmentRow,
  type CampaignResultMessageRow,
} from "@/lib/marketing/campaign-results";
import { AdPerformanceDashboard } from "./_components/ad-dashboard";

export const metadata = { title: ROUTE_NAME["/staff/marketing"] };
export const dynamic = "force-dynamic";

// Ad-spend analytics (marketing workspace, tab 1 of 3). Mostly a read-only
// client tool (CSV upload + localStorage), but it also shows what the
// clinic's OWN records say each campaign produced — bookings and website
// messages — next to the ad platforms' own numbers. That half is computed
// here, server-side, with the RLS-scoped client: only day/campaign COUNTS
// (src/lib/marketing/campaign-results.ts) cross to the client component,
// never names, ids, contact details or raw attribution (RA 10173).
export default async function MarketingAdPerformancePage() {
  await requireAdminStaff();

  const todayISO = todayManilaISODate();
  const fromISO = shiftISODate(todayISO, -400);
  const { fromIso } = manilaRangeUtc(fromISO, todayISO);
  const supabase = await createClient();

  const [
    { rows: apptRows, truncated: apptTruncated },
    { rows: msgRows, truncated: msgTruncated },
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
  ]);

  const dailyCampaignCounts = buildDailyCampaignCounts(apptRows, msgRows);
  const campaignResultsTruncated = apptTruncated || msgTruncated;

  return (
    <AdPerformanceDashboard
      dailyCampaignCounts={dailyCampaignCounts}
      campaignResultsTruncated={campaignResultsTruncated}
    />
  );
}
