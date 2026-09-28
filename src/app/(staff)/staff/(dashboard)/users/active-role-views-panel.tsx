// Admin-only readout (the page is behind requireAdminStaff): which admins are
// viewing the app as another role right now, and until when (Manila time).
// Spec addendum A3 adds "End now" on each line except the viewing admin's
// own — they can't reach this page while simulating anyway (their effective
// role isn't admin), but the check is explicit rather than relying on that.
// The panel stays a server component; EndRoleViewButton is the only client
// piece.
import { Panel } from "@/components/ui/panel";
import { formatRemaining } from "@/lib/auth/view-as";
import { manilaTime } from "@/lib/dates/manila";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import type { ActiveRoleView } from "@/lib/staff/active-role-views";
import { EndRoleViewButton } from "./end-role-view-button";

export function ActiveRoleViewsPanel({
  views,
  now,
  currentAdminId,
}: {
  views: ActiveRoleView[];
  now: Date;
  currentAdminId: string;
}) {
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
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <b>{v.full_name}</b> is viewing as {ROLE_LABEL[v.role]} until {manilaTime(v.until)} (
                {formatRemaining(v.until, now)} left)
              </span>
              {v.id !== currentAdminId ? <EndRoleViewButton targetId={v.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
