"use client";

// Admin "View as role" banner. The database applies the override on every
// request, but the shell that renders this banner lives in a layout Next
// caches across client navigations. So the banner refreshes the route:
//   - once, just after `until` (the override has expired → banner drops);
//   - whenever the tab becomes visible again (a switch or exit made in
//     another tab/device is picked up when the admin comes back).
// A tab that stays in the foreground while another device switches keeps
// the stale shell until its next navigation; every server render and action
// still uses the database's effective role, so a stale shell can mislead,
// never authorize. `remainingLabel` is computed server-side (formatRemaining)
// so the SSR markup carries a real countdown.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { exitViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import type { ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import { ViewAsSelect } from "./view-as-select";

interface Props {
  role: ViewAsRole;
  /** ISO-8601; the moment the override stops applying. */
  until: string;
  remainingLabel: string;
}

function useRefreshOnVisible() {
  const router = useRouter();
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);
}

export function ViewAsBanner({ role, until, remainingLabel }: Props) {
  const router = useRouter();
  useRefreshOnVisible();
  useEffect(() => {
    // +1s so the server's strict `until > now()` is already false.
    const ms = Math.max(0, Date.parse(until) - Date.now()) + 1_000;
    const timer = setTimeout(() => router.refresh(), ms);
    return () => clearTimeout(timer);
  }, [until, router]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 print:hidden"
    >
      <p className="min-w-0 flex-1">
        <b>Viewing as {ROLE_LABEL[role]}.</b> Anything you save is recorded under
        your name. Ends in {remainingLabel}.
      </p>
      <ViewAsSelect current={role} id="view-as-banner" className="w-44" />
      <form action={exitViewAsAction}>
        <Button type="submit" size="sm" variant="outline">
          Exit
        </Button>
      </form>
    </div>
  );
}

/** Headless: rendered for an admin with NO active override so a start made
 *  in another tab/device shows up here when this tab regains focus. */
export function RefreshOnFocus() {
  useRefreshOnVisible();
  return null;
}
