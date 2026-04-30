import "server-only";
import { redirect } from "next/navigation";
import {
  requireActiveStaff,
  type StaffSession,
} from "@/lib/auth/require-staff";

// Like requireActiveStaff(), but additionally forces an admin role.
// Use at the top of admin-only pages and inside admin-only server actions.
export async function requireAdminStaff(): Promise<StaffSession> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    redirect("/staff");
  }
  return session;
}
