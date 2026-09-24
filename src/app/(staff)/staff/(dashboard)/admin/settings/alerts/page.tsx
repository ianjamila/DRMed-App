import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { STAFF_ALERT_LIST, type StaffAlertKey } from "@/lib/notifications/staff-alerts";
import { loadActiveStaffForAlerts } from "@/lib/notifications/staff-alert-recipients";
import { normaliseAlertSentMetadata } from "@/lib/notifications/alert-last-sent";
import { AlertCard, type AlertExtraAddressProp, type AlertLastSentProp } from "./client";

export const metadata = { title: ROUTE_NAME["/staff/admin/settings/alerts"] };
export const dynamic = "force-dynamic";

export default async function EmailAlertsPage() {
  await requireAdminStaff();
  // Staff sign-in emails live in auth.users, which only the service-role
  // client can list — that is the one read that needs it. The alert settings
  // and audit_log are admin-only under RLS (0155; 0001/0151), so they are
  // read with the RLS client like every other staff read in this app.
  const admin = createAdminClient();
  const supabase = await createClient();

  const [staff, settingsRes, recipientsRes, lastSentRows] = await Promise.all([
    loadActiveStaffForAlerts(admin),
    supabase.from("staff_alert_settings").select("alert_key, enabled"),
    supabase.from("staff_alert_recipients").select("id, alert_key, staff_id, email, subscribed"),
    Promise.all(
      STAFF_ALERT_LIST.map((def) =>
        supabase
          .from("audit_log")
          .select("created_at, metadata")
          .eq("action", def.sentAction)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
  ]);

  const enabledByKey = new Map<StaffAlertKey, boolean>(
    (settingsRes.data ?? []).map((r) => [r.alert_key as StaffAlertKey, r.enabled]),
  );

  const overridesByAlert = new Map<StaffAlertKey, Record<string, boolean>>();
  const extrasByAlert = new Map<StaffAlertKey, AlertExtraAddressProp[]>();
  for (const def of STAFF_ALERT_LIST) {
    overridesByAlert.set(def.key, {});
    extrasByAlert.set(def.key, []);
  }
  for (const row of recipientsRes.data ?? []) {
    const key = row.alert_key as StaffAlertKey;
    if (row.staff_id) {
      overridesByAlert.get(key)![row.staff_id] = row.subscribed;
    } else if (row.email) {
      extrasByAlert.get(key)!.push({ id: row.id, email: row.email, subscribed: row.subscribed });
    }
  }

  const staffForClient = staff.map((s) => ({
    id: s.id,
    fullName: s.fullName,
    role: s.role,
    email: s.email,
  }));

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME["/staff/admin/settings/alerts"]}
        subtitle="Choose who gets the clinic's alert emails — new website messages, result-template problems and possible duplicate patients. Switch each alert on or off, pick staff one by one, or add a shared inbox."
      />

      <div className="space-y-6">
        {STAFF_ALERT_LIST.map((def, i) => {
          const row = lastSentRows[i];
          const lastSent: AlertLastSentProp | null = row?.data
            ? { at: row.data.created_at, ...normaliseAlertSentMetadata(row.data.metadata) }
            : null;
          return (
            <AlertCard
              key={def.key}
              alertKey={def.key}
              label={def.label}
              description={def.description}
              defaultRoles={def.defaultRoles}
              initialEnabled={enabledByKey.get(def.key) ?? true}
              staff={staffForClient}
              initialOverrides={overridesByAlert.get(def.key) ?? {}}
              initialExtras={extrasByAlert.get(def.key) ?? []}
              lastSent={lastSent}
            />
          );
        })}
      </div>

      <p className="mt-6 text-xs text-[color:var(--color-brand-text-soft)]">
        Every change here is recorded in the audit log.
      </p>
    </div>
  );
}
