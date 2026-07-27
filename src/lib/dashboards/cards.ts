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
  // Ships OFF for the roles above — the card is real and supported, it just
  // isn't worth dashboard space by default. Admin can turn it on per role from
  // Dashboard settings like any other card; the stored preference always wins
  // over this default. See hiddenCardIdsFor().
  defaultHidden?: boolean;
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
  // Off by default since partner revision 8 sent "Sell gift code" to the
  // admin-only Hidden tabs section: counter sales are rare enough that a
  // standing tile (usually reading 0) isn't worth the space. Reception reaches
  // the sell page from the Front desk quicklink instead.
  { id: "reception.gift_codes_sold",   label: "Gift codes sold",   roles: ["reception"], group: "snapshot", defaultHidden: true },
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
  { id: "admin.dup_candidates",    label: "Possible duplicates", roles: ["admin"], group: "operations" },

  // ---- Admin: Money -------------------------------------------------------
  { id: "admin.net_income_mtd",        label: "Net income (this month)",  roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.past_due_periods",     label: "Past-due open periods",    roles: ["admin"], group: "money" },
  { id: "admin.draft_jes",            label: "Draft journal entries",    roles: ["admin"], group: "money" },
  { id: "admin.ap_outstanding",       label: "AP outstanding",           roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.ap_overdue",           label: "AP bills overdue",         roles: ["admin"], group: "money" },
  { id: "admin.hmo_unbilled_aged",    label: "HMO unbilled aged 90+",    roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.patient_ar",           label: "Patient AR outstanding",   roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.advances_outstanding", label: "Staff advances outstanding", roles: ["admin"], group: "money", sensitive: true },
  { id: "admin.pf_to_pay",            label: "Doctors to pay",           roles: ["admin"], group: "money", sensitive: true },
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

// Resolves stored preferences against the registry's defaults into the set of
// card ids that must NOT render for `role`. `prefs` are the rows for that role
// only. Precedence: a stored row always wins; with no stored row the card's
// `defaultHidden` decides. Rows for ids no longer in the registry are still
// honoured so a retired card can't come back through the back door.
export function hiddenCardIdsFor(
  role: DashboardRole,
  prefs: readonly { card_id: string; visible: boolean }[],
): Set<string> {
  const stored = new Map<string, boolean>();
  for (const p of prefs) stored.set(p.card_id, p.visible);

  const hidden = new Set<string>();
  for (const [cardId, visible] of stored) {
    if (!visible) hidden.add(cardId);
  }
  for (const card of DASHBOARD_CARDS) {
    if (card.defaultHidden && card.roles.includes(role) && !stored.has(card.id)) {
      hidden.add(card.id);
    }
  }
  return hidden;
}

// True when `visible` is what the card would do on its own, i.e. no stored row
// is needed. Keeps dashboard_card_prefs to genuine overrides only.
export function matchesCardDefault(card: CardDef, visible: boolean): boolean {
  return visible === !card.defaultHidden;
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
