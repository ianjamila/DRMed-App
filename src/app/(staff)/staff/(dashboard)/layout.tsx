import { requireActiveStaff } from "@/lib/auth/require-staff";
import { StaffShell } from "@/components/staff/staff-shell";

export default async function StaffDashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireActiveStaff();
  return <StaffShell session={session}>{children}</StaffShell>;
}
