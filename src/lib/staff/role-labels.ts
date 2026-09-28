// src/lib/staff/role-labels.ts
import type { StaffSession } from "@/lib/auth/require-staff";

/** Plain names for staff roles, as shown in the shell footer, the mobile
 *  topbar pill and the View-as controls. */
export const ROLE_LABEL: Record<StaffSession["role"], string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};
