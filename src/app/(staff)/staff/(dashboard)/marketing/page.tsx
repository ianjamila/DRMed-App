import { requireAdminStaff } from "@/lib/auth/require-admin";
import { AdPerformanceDashboard } from "./_components/ad-dashboard";

export const metadata = { title: "Ad performance — DRMed" };
export const dynamic = "force-dynamic";

// Ad-spend analytics (marketing workspace, tab 1 of 2). A read-only client
// tool: CSV upload + localStorage, no database access — so the admin gate is
// the only server-side concern here.
export default async function MarketingAdPerformancePage() {
  await requireAdminStaff();
  return <AdPerformanceDashboard />;
}
