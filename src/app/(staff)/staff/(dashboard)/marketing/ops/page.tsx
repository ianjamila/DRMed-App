import { ROUTE_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { OpsTracker } from "../_components/ops-tracker";

export const metadata = { title: ROUTE_NAME["/staff/marketing/ops"] };
export const dynamic = "force-dynamic";

// Marketing operations tracker (marketing workspace, tab 2 of 2). A read-only
// client tool: checklists + roadmap + campaign board in localStorage, no
// database access — so the admin gate is the only server-side concern here.
export default async function MarketingOpsTrackerPage() {
  await requireAdminStaff();
  return <OpsTracker />;
}
