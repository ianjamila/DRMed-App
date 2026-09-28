// Who is currently using admin "View as role" — for the Staff Users readout.
// Same rule as the session and RLS (activeViewAs): admin row, future expiry.
import { activeViewAs, type ViewAsRole } from "@/lib/auth/view-as";

export interface ActiveRoleView {
  id: string;
  full_name: string;
  role: ViewAsRole;
  until: string;
}

interface Row {
  id: string;
  full_name: string;
  role: string;
  view_as_role: string | null;
  view_as_until: string | null;
  deleted_at: string | null;
  is_active: boolean;
}

export function activeRoleViews(rows: Row[], now: Date = new Date()): ActiveRoleView[] {
  const out: ActiveRoleView[] = [];
  for (const r of rows) {
    if (r.deleted_at !== null || !r.is_active) continue;
    const v = activeViewAs(r, now);
    if (v) out.push({ id: r.id, full_name: r.full_name, role: v.role, until: v.until });
  }
  // Soonest ending first; id breaks ties so the order is total (repo rule).
  return out.sort((a, b) => Date.parse(a.until) - Date.parse(b.until) || a.id.localeCompare(b.id));
}
