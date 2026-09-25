import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { StaffShell } from "@/components/staff/staff-shell";
import { Toaster } from "@/components/ui/sonner";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report-error";

const BADGE_ROLES: ReadonlyArray<StaffSession["role"]> = ["reception", "admin"];

// Sidebar nav count badges, keyed by item href. Currently just the Website
// Messages inbox's "new" count (roles: reception/admin — the roles that see
// the item). A failed count must never break the shell: report it and render
// no badge rather than let the layout throw.
async function loadNavBadges(
  session: StaffSession,
): Promise<Record<string, number>> {
  if (!BADGE_ROLES.includes(session.role)) return {};
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("contact_messages")
      .select("id", { count: "exact", head: true })
      .eq("status", "new");
    if (error) {
      await reportError({
        scope: "staff-layout.nav-badges",
        error,
        metadata: { userId: session.user_id },
      });
      return {};
    }
    return count && count > 0 ? { "/staff/messages": count } : {};
  } catch (error) {
    await reportError({
      scope: "staff-layout.nav-badges",
      error,
      metadata: { userId: session.user_id },
    });
    return {};
  }
}

export default async function StaffDashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireActiveStaff();
  const badges = await loadNavBadges(session);
  return (
    <>
      <StaffShell session={session} badges={badges}>{children}</StaffShell>
      {/* Toasts never belong on paper — and sonner's empty live region sits
          in flow after the shell, which is enough to push a blank last page
          onto a printed receipt or slip. */}
      <div className="print:hidden">
        <Toaster position="top-right" richColors />
      </div>
    </>
  );
}
