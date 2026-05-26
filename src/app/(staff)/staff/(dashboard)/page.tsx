import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ReceptionDashboard } from "./_dashboards/reception-dashboard";
import { LabDashboard } from "./_dashboards/lab-dashboard";
import { AdminDashboard } from "./_dashboards/admin-dashboard";

export const metadata = {
  title: "Dashboard — staff",
};

export const dynamic = "force-dynamic";

export default async function StaffDashboardPage() {
  const session = await requireActiveStaff();

  switch (session.role) {
    case "reception":
      return <ReceptionDashboard session={session} />;
    case "medtech":
    case "xray_technician":
    case "pathologist":
      return <LabDashboard session={session} />;
    case "admin":
      return <AdminDashboard session={session} />;
    default:
      // Future-proof: any new role added in the DB before the frontend is
      // updated falls back to the admin shell rather than rendering blank.
      return <AdminDashboard session={session} />;
  }
}
