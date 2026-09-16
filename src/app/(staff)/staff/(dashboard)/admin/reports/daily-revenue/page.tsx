import { permanentRedirect } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { dailyRevenueRedirectHref } from "@/lib/reports/daily-revenue";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = { title: ROUTE_NAME["/staff/admin/operations/daily-revenue"] };

export default async function LegacyDailyRevenuePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminStaff();
  permanentRedirect(dailyRevenueRedirectHref(await searchParams));
}
