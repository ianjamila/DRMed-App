import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  STAFF_ALERTS,
  computeAlertRecipients,
  type AlertRecipients,
  type AlertStaffMember,
  type StaffAlertKey,
} from "@/lib/notifications/staff-alerts";

// The one place a sender asks "who gets this alert right now?" (0155). Reads
// with the service-role client because senders run in cron routes and in the
// public contact form's after() hook, where there is no staff session.
//
// An unreadable settings row fails OPEN to the alert's defaults (enabled, the
// default roles): a broken settings read must not silently stop clinic alerts.

type AdminClient = ReturnType<typeof createAdminClient>;

/** Every auth user's email by id. Pages through listUsers so a clinic with
 * more than one page of accounts still resolves everyone. */
export async function loadAuthEmails(admin: AdminClient): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) break;
    for (const u of data.users) {
      if (u.id && u.email) byId.set(u.id, u.email);
    }
    if (data.users.length < perPage) break;
  }
  return byId;
}

/** Active staff with their sign-in email (null when the account has none). */
export async function loadActiveStaffForAlerts(
  admin: AdminClient,
): Promise<Array<AlertStaffMember & { fullName: string }>> {
  const [{ data: profiles }, emails] = await Promise.all([
    admin
      .from("staff_profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name", { ascending: true })
      .order("id", { ascending: true }),
    loadAuthEmails(admin),
  ]);
  return (profiles ?? []).map((p) => ({
    id: p.id,
    fullName: p.full_name,
    role: p.role as AlertStaffMember["role"],
    email: emails.get(p.id) ?? null,
  }));
}

export async function resolveStaffAlertRecipients(
  key: StaffAlertKey,
  admin: AdminClient = createAdminClient(),
): Promise<AlertRecipients> {
  const def = STAFF_ALERTS[key];
  const [settingRes, recipientsRes, staff] = await Promise.all([
    admin.from("staff_alert_settings").select("enabled").eq("alert_key", key).maybeSingle(),
    admin.from("staff_alert_recipients").select("staff_id, email, subscribed").eq("alert_key", key),
    loadActiveStaffForAlerts(admin),
  ]);
  const overrides = new Map<string, boolean>();
  const extras: Array<{ email: string; subscribed: boolean }> = [];
  for (const r of recipientsRes.data ?? []) {
    if (r.staff_id) overrides.set(r.staff_id, r.subscribed);
    else if (r.email) extras.push({ email: r.email, subscribed: r.subscribed });
  }
  return computeAlertRecipients({
    enabled: settingRes.error || !settingRes.data ? true : settingRes.data.enabled,
    defaultRoles: def.defaultRoles,
    staff,
    overrides,
    extras,
  });
}
