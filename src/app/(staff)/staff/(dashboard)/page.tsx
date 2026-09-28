import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ReceptionDashboard } from "./_dashboards/reception-dashboard";
import { LabDashboard } from "./_dashboards/lab-dashboard";
import { AdminDashboard } from "./_dashboards/admin-dashboard";
import { isRevenuePresetKey } from "@/lib/visits/revenue-presets";

export const metadata = {
  title: "Dashboard",
};

export const dynamic = "force-dynamic";

export default async function StaffDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ revenue?: string }>;
}) {
  const session = await requireActiveStaff();
  const { revenue } = await searchParams;
  // The admin "Revenue by classification" dropdown's date range. Absent (or
  // unrecognised) = This month, collapsed; present = that range, expanded.
  const revenuePreset = isRevenuePresetKey(revenue) ? revenue : null;

  switch (session.role) {
    case "reception":
      return <ReceptionDashboard session={session} />;
    case "medtech":
    case "xray_technician":
    case "pathologist":
      return <LabDashboard session={session} />;
    case "admin":
      return <AdminDashboard session={session} revenuePreset={revenuePreset} />;
    default:
      // Future-proof: any new role added in the DB before the frontend is
      // updated falls back to the admin shell rather than rendering blank.
      return <AdminDashboard session={session} revenuePreset={revenuePreset} />;
  }
}
