import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
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
// Every failed read is still reported (Sentry) and returned as `loadError`,
// so a sender never audits it as "nobody is switched on" (alertSkipReason).

type AdminClient = ReturnType<typeof createAdminClient>;

/** The most pages loadAuthEmails walks (200 accounts each) before it gives up. */
const MAX_AUTH_PAGES = 50;

/** Every auth user's email by id. Pages through listUsers so a clinic with
 * more than one page of accounts still resolves everyone. A failed page — or
 * running out of pages while they are still full — is an `error`, never a
 * quietly shorter map: a missing email reads downstream as "this person has
 * no email", and an empty map as "nobody is switched on". */
export async function loadAuthEmails(
  admin: AdminClient,
): Promise<{ byId: Map<string, string>; error: string | null }> {
  const byId = new Map<string, string>();
  const perPage = 200;
  for (let page = 1; page <= MAX_AUTH_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) {
      return { byId, error: `staff sign-in emails, page ${page}: ${error?.message ?? "no data"}` };
    }
    for (const u of data.users) {
      if (u.id && u.email) byId.set(u.id, u.email);
    }
    if (data.users.length < perPage) return { byId, error: null };
  }
  return { byId, error: `staff sign-in emails: more than ${MAX_AUTH_PAGES * perPage} accounts, list cut short` };
}

/** Active staff with their sign-in email (null when the account has none, or
 * when the email list could not be read — then `loadError` says so). */
export async function loadActiveStaffForAlerts(admin: AdminClient): Promise<{
  staff: Array<AlertStaffMember & { fullName: string }>;
  loadError: string | null;
}> {
  const [{ data: profiles, error: profilesErr }, emails] = await Promise.all([
    admin
      .from("staff_profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name", { ascending: true })
      .order("id", { ascending: true }),
    loadAuthEmails(admin),
  ]);
  const errors = [
    profilesErr ? `staff list: ${profilesErr.message}` : null,
    emails.error,
  ].filter((e): e is string => e !== null);
  return {
    staff: (profiles ?? []).map((p) => ({
      id: p.id,
      fullName: p.full_name,
      role: p.role as AlertStaffMember["role"],
      email: emails.byId.get(p.id) ?? null,
    })),
    loadError: errors.length > 0 ? errors.join("; ") : null,
  };
}

export type ResolvedAlertRecipients = AlertRecipients & {
  /** Set when any read behind this list failed — the list may be short or
   * empty for that reason, not because of the Email Alerts settings. */
  loadError: string | null;
};

export async function resolveStaffAlertRecipients(
  key: StaffAlertKey,
  admin: AdminClient = createAdminClient(),
): Promise<ResolvedAlertRecipients> {
  const def = STAFF_ALERTS[key];
  const [settingRes, recipientsRes, staffRes] = await Promise.all([
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
  const errors = [
    settingRes.error ? `alert settings: ${settingRes.error.message}` : null,
    recipientsRes.error ? `alert recipients: ${recipientsRes.error.message}` : null,
    staffRes.loadError,
  ].filter((e): e is string => e !== null);
  const loadError = errors.length > 0 ? errors.join("; ") : null;
  if (loadError) {
    // Still send to whoever could be resolved (a broken read must not
    // silently stop clinic alerts), but make the failure visible.
    try {
      await reportError({
        scope: "notify/staff-alert-recipients",
        error: new Error(loadError),
        metadata: { alert_key: key },
      });
    } catch {
      // Reporting failed — still return what could be resolved (fail open).
    }
  }
  return {
    ...computeAlertRecipients({
      enabled: settingRes.error || !settingRes.data ? true : settingRes.data.enabled,
      defaultRoles: def.defaultRoles,
      staff: staffRes.staff,
      overrides,
      extras,
    }),
    loadError,
  };
}
