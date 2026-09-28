// Admin-only readout (the page is behind requireAdminStaff): which admins are
// viewing the app as another role right now, and until when (Manila time).
import { Panel } from "@/components/ui/panel";
import { formatRemaining } from "@/lib/auth/view-as";
import { manilaTime } from "@/lib/dates/manila";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import type { ActiveRoleView } from "@/lib/staff/active-role-views";

export function ActiveRoleViewsPanel({ views, now }: { views: ActiveRoleView[]; now: Date }) {
  return (
    <Panel className="mb-6 p-4">
      <h2 className="text-sm font-bold text-[color:var(--color-brand-navy)]">Active role views</h2>
      {views.length === 0 ? (
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          No one is viewing the app as another role.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {views.map((v) => (
            <li key={v.id}>
              <b>{v.full_name}</b> is viewing as {ROLE_LABEL[v.role]} until {manilaTime(v.until)} (
              {formatRemaining(v.until, now)} left)
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
