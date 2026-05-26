import type { StaffSession } from "@/lib/auth/require-staff";

export type DashboardRole = StaffSession["role"];

export interface CardDef {
  id: string;
  label: string;
  // Roles that natively see this card based on its role-conditional rules.
  // Settings UI shows the card under each of these role tabs.
  roles: readonly DashboardRole[];
  group: "snapshot" | "operations" | "money" | "people" | "attention";
  sensitive?: boolean;
}

// Stable card-id registry. The id is what's stored in
// dashboard_card_prefs.card_id. Renaming a label is fine; renaming the id
// drops any existing override on it.
export const DASHBOARD_CARDS: readonly CardDef[] = [
  // ---- Reception ----------------------------------------------------------
  { id: "reception.visits_today",      label: "Visits today",      roles: ["reception"], group: "snapshot" },
  { id: "reception.unpaid_balance",    label: "Unpaid balance",    roles: ["reception"], group: "snapshot", sensitive: true },
  { id: "reception.pending_release",   label: "Pending release",   roles: ["reception"], group: "snapshot" },
  { id: "reception.walk_ins_waiting",  label: "Walk-ins waiting",  roles: ["reception"], group: "snapshot" },
  { id: "reception.open_inquiries",    label: "Open inquiries",    roles: ["reception"], group: "snapshot" },
  { id: "reception.gift_codes_sold",   label: "Gift codes sold",   roles: ["reception"], group: "snapshot" },
  { id: "reception.cash_drawer",       label: "Cash drawer",       roles: ["reception"], group: "snapshot", sensitive: true },
  { id: "reception.strip_appointments", label: "Strip: next appointments", roles: ["reception"], group: "attention" },
  { id: "reception.strip_unpaid",       label: "Strip: today's unpaid",    roles: ["reception"], group: "attention", sensitive: true },
  { id: "reception.strip_inquiries",    label: "Strip: recent inquiries",  roles: ["reception"], group: "attention" },

  // ---- Lab ----------------------------------------------------------------
  { id: "lab.my_unclaimed",         label: "Unclaimed in my sections", roles: ["medtech", "xray_technician"], group: "snapshot" },
  { id: "lab.my_claimed",           label: "Claimed by me",            roles: ["medtech", "xray_technician"], group: "snapshot" },
  { id: "lab.ready_for_signoff",    label: "Ready for sign-off",       roles: ["pathologist"], group: "snapshot" },
  { id: "lab.critical_alerts",      label: "Critical alerts unacked",  roles: ["pathologist"], group: "snapshot" },
  { id: "lab.send_out_awaiting",    label: "Send-out awaiting result", roles: ["medtech"], group: "snapshot" },
  { id: "lab.released_today",       label: "Released today",           roles: ["medtech", "xray_technician", "pathologist"], group: "snapshot" },
  { id: "lab.strip_oldest_unclaimed", label: "Strip: oldest unclaimed", roles: ["medtech", "xray_technician"], group: "attention" },
  { id: "lab.strip_pending_signoff",  label: "Strip: pending sign-off", roles: ["pathologist"], group: "attention" },
  { id: "lab.strip_recent_criticals", label: "Strip: recent criticals", roles: ["medtech", "pathologist"], group: "attention" },

  // ---- Admin: Operations --------------------------------------------------
  { id: "admin.revenue_today",     label: "Revenue today",   roles: ["admin"], group: "operations", sensitive: true },
  { id: "admin.visits_today",      label: "Visits today",    roles: ["admin"], group: "operations" },
  { id: "admin.queue_total",       label: "Queue",           roles: ["admin"], group: "operations" },
  { id: "admin.released_today",    label: "Released today",  roles: ["admin"], group: "operations" },

  // ---- Admin: Money -------------------------------------------------------
  { id: "admin.past_due_periods",     label: "Past-due open periods",    roles: ["admin"], group: "money" },
  { id: "admin.draft_jes",            label: "Draft journal entries",    roles: ["admin"], group: "money" },
  { id: "admin.ap_outstanding",       label: "AP outstanding",           roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.ap_overdue",           label: "AP bills overdue",         roles: ["admin"], group: "money" },
  { id: "admin.hmo_unbilled_aged",    label: "HMO unbilled aged 90+",    roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.patient_ar",           label: "Patient AR outstanding",   roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.advances_outstanding", label: "Staff advances outstanding", roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.pf_pending",           label: "Doctor PF pending",        roles: ["admin"], group: "money", sensitive: true },

  // ---- Admin: People ------------------------------------------------------
  { id: "admin.active_employees",        label: "Active employees",          roles: ["admin"], group: "people" },
  { id: "admin.payroll_runs",            label: "Payroll runs in progress",  roles: ["admin"], group: "people" },

  // ---- Admin: Attention ---------------------------------------------------
  { id: "admin.strip_audit",         label: "Strip: recent audit anomalies", roles: ["admin"], group: "attention" },
  { id: "admin.strip_stale_drafts",  label: "Strip: stale draft journals",   roles: ["admin"], group: "attention" },
] as const;

export function cardsForRole(role: DashboardRole): readonly CardDef[] {
  return DASHBOARD_CARDS.filter((c) => c.roles.includes(role));
}

export const ROLE_LABELS: Record<DashboardRole, string> = {
  reception: "Reception",
  medtech: "Medtech",
  xray_technician: "X-ray / Imaging",
  pathologist: "Pathologist",
  admin: "Admin",
};

export const ALL_ROLES: readonly DashboardRole[] = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
] as const;
