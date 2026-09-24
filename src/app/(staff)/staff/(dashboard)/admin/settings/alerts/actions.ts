"use server";

// Admin Tools › Email Alerts — Server Actions. Every export re-checks admin
// (requireAdminStaff) and re-validates its input with zod, because a Server
// Action is a callable endpoint regardless of which button on the page calls
// it (same shape as messages/actions.ts).
//
// Writes go through the RLS-scoped server client, not the admin client:
// migration 0155 grants admins select+update on staff_alert_settings and
// full manage on staff_alert_recipients, so Postgres is the second line of
// defense here too. The admin client is used only for the two service-role
// reads that don't have (and don't need) an RLS path: the resolved "who
// actually gets this right now" list (resolveStaffAlertRecipients, which
// itself pages auth.users for staff emails) used by the test-send action.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, escapeHtml } from "@/lib/notifications/branded-email";
import { STAFF_ALERT_KEYS, STAFF_ALERTS, ALERT_EXTRA_EMAIL_MAX, type StaffAlertKey } from "@/lib/notifications/staff-alerts";
import { resolveStaffAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { isValidAlertEmail } from "@/lib/notifications/alert-email";

interface ErrResult {
  ok: false;
  error: string;
}
type ActionResult = { ok: true } | ErrResult;
type ActionDataResult<T> = { ok: true; data: T } | ErrResult;

const ALERTS_PATH = "/staff/admin/settings/alerts";

const KeySchema = z.enum(STAFF_ALERT_KEYS);

const EnabledSchema = z.object({ key: KeySchema, enabled: z.boolean() });
const StaffAlertSchema = z.object({
  key: KeySchema,
  staffId: z.string().uuid(),
  subscribed: z.boolean(),
});
const ResetSchema = z.object({ key: KeySchema });
const AddEmailSchema = z.object({
  key: KeySchema,
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address.")
    .max(ALERT_EXTRA_EMAIL_MAX, `Must be ${ALERT_EXTRA_EMAIL_MAX} characters or fewer.`)
    .refine(isValidAlertEmail, "Enter a valid email address."),
});
const SetEmailSubscribedSchema = z.object({
  recipientId: z.string().uuid(),
  subscribed: z.boolean(),
});
const RemoveEmailSchema = z.object({ recipientId: z.string().uuid() });
const SendTestSchema = z.object({ key: KeySchema });

function revalidateAlertsPage() {
  revalidatePath(ALERTS_PATH);
}

// Turn one alert on/off entirely (staff_alert_settings.enabled). Off means
// nobody is emailed, regardless of individual switches or extra addresses.
export async function setAlertEnabledAction(
  key: StaffAlertKey,
  enabled: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = EnabledSchema.safeParse({ key, enabled });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read the alert.") };

  const supabase = await createClient();
  const { error } = await supabase
    .from("staff_alert_settings")
    .update({ enabled: parsed.data.enabled, updated_by: session.user_id })
    .eq("alert_key", parsed.data.key);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.enabled_changed",
    resource_type: "staff_alert_settings",
    // Global singleton per alert_key (not a uuid row) — the change is
    // captured in metadata instead, same pattern as consent_settings /
    // booking_settings.
    resource_id: null,
    metadata: { alert_key: parsed.data.key, enabled: parsed.data.enabled },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true };
}

// Switch one active staff member on/off for one alert. Upserts an override
// row on (alert_key, staff_id) — done as select-then-write rather than a
// Postgres upsert, because the table's uniqueness on that pair is a PARTIAL
// index (`where staff_id is not null`, migration 0155) and Postgres only
// infers a partial index as an ON CONFLICT target when the clause restates
// the same predicate, which PostgREST's upsert doesn't emit.
export async function setStaffAlertAction(
  key: StaffAlertKey,
  staffId: string,
  subscribed: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = StaffAlertSchema.safeParse({ key, staffId, subscribed });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read that change.") };

  const supabase = await createClient();

  const { data: activeStaff } = await supabase
    .from("staff_profiles")
    .select("id")
    .eq("id", parsed.data.staffId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (!activeStaff) {
    return { ok: false, error: "That staff member is not active." };
  }

  const { data: existing } = await supabase
    .from("staff_alert_recipients")
    .select("id")
    .eq("alert_key", parsed.data.key)
    .eq("staff_id", parsed.data.staffId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("staff_alert_recipients")
      .update({ subscribed: parsed.data.subscribed })
      .eq("id", existing.id);
    if (error) return { ok: false, error: translatePgError(error) };
  } else {
    const { error } = await supabase.from("staff_alert_recipients").insert({
      alert_key: parsed.data.key,
      staff_id: parsed.data.staffId,
      subscribed: parsed.data.subscribed,
      created_by: session.user_id,
    });
    if (error) return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.staff_changed",
    resource_type: "staff_alert_recipients",
    resource_id: null,
    metadata: {
      alert_key: parsed.data.key,
      staff_id: parsed.data.staffId,
      subscribed: parsed.data.subscribed,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true };
}

// Delete every per-staff override for one alert, so every active staff
// member falls back to the role default again. Extra addresses are not
// touched — they have no "default" to fall back to.
export async function resetStaffAlertDefaultsAction(
  key: StaffAlertKey,
): Promise<ActionDataResult<{ removed: number }>> {
  const session = await requireAdminStaff();
  const parsed = ResetSchema.safeParse({ key });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read the alert.") };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_alert_recipients")
    .delete()
    .eq("alert_key", parsed.data.key)
    .not("staff_id", "is", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };

  const removed = data?.length ?? 0;
  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.defaults_restored",
    resource_type: "staff_alert_recipients",
    resource_id: null,
    metadata: { alert_key: parsed.data.key, removed },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true, data: { removed } };
}

// Add an extra address (a shared inbox, or someone outside the staff list).
// Validated against the same shape as the DB CHECK (isValidAlertEmail)
// before the insert, so the common case never round-trips through Postgres
// to get told the value is invalid.
export async function addAlertEmailAction(
  key: StaffAlertKey,
  email: string,
): Promise<ActionDataResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddEmailSchema.safeParse({ key, email });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Enter a valid email address.") };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_alert_recipients")
    .insert({
      alert_key: parsed.data.key,
      email: parsed.data.email,
      subscribed: true,
      created_by: session.user_id,
    })
    .select("id")
    .single();

  if (error) {
    // uq_staff_alert_recipients_email — same address already on this alert.
    if (error.code === "23505") return { ok: false, error: "That address is already on this alert." };
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.email_added",
    resource_type: "staff_alert_recipients",
    resource_id: data.id,
    // A clinic/staff address, not patient data — fine to log in full.
    metadata: { alert_key: parsed.data.key, email: parsed.data.email },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true, data: { id: data.id } };
}

// Pause/resume one extra address without deleting it.
export async function setAlertEmailSubscribedAction(
  recipientId: string,
  subscribed: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = SetEmailSubscribedSchema.safeParse({ recipientId, subscribed });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read that change.") };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("staff_alert_recipients")
    .select("id, alert_key, email")
    .eq("id", parsed.data.recipientId)
    .is("staff_id", null)
    .maybeSingle();
  if (!existing || !existing.email) return { ok: false, error: "That address could not be found." };

  const { error } = await supabase
    .from("staff_alert_recipients")
    .update({ subscribed: parsed.data.subscribed })
    .eq("id", parsed.data.recipientId);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.email_changed",
    resource_type: "staff_alert_recipients",
    resource_id: parsed.data.recipientId,
    metadata: { alert_key: existing.alert_key, email: existing.email, subscribed: parsed.data.subscribed },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true };
}

// Remove an extra address entirely.
export async function removeAlertEmailAction(recipientId: string): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = RemoveEmailSchema.safeParse({ recipientId });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read that address.") };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("staff_alert_recipients")
    .select("id, alert_key, email")
    .eq("id", parsed.data.recipientId)
    .is("staff_id", null)
    .maybeSingle();
  if (!existing || !existing.email) return { ok: false, error: "That address could not be found." };

  const { error } = await supabase
    .from("staff_alert_recipients")
    .delete()
    .eq("id", parsed.data.recipientId);
  if (error) return { ok: false, error: translatePgError(error) };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.email_removed",
    resource_type: "staff_alert_recipients",
    resource_id: parsed.data.recipientId,
    metadata: { alert_key: existing.alert_key, email: existing.email },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateAlertsPage();
  return { ok: true };
}

// Email a clearly-marked test to this alert's CURRENT recipients, resolved
// server-side by resolveStaffAlertRecipients — never a client-supplied list,
// so a stale/tampered browser state can't redirect a test (or trick the
// server into thinking who receives the real alert). Refuses when the alert
// is off or would currently reach nobody, matching the disabled button state
// on the page.
export async function sendTestAlertAction(
  key: StaffAlertKey,
): Promise<ActionDataResult<{ sent: number; failed: number; skipped: string | null }>> {
  const session = await requireAdminStaff();
  const parsed = SendTestSchema.safeParse({ key });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Could not read the alert.") };

  const def = STAFF_ALERTS[parsed.data.key];
  const admin = createAdminClient();
  const recipients = await resolveStaffAlertRecipients(parsed.data.key, admin);

  if (!recipients.enabled) {
    return { ok: false, error: "This alert is switched off. Turn it on to send a test." };
  }
  if (recipients.emails.length === 0) {
    return {
      ok: false,
      error: "Nobody would receive this alert right now — switch on a staff member or add an address first.",
    };
  }

  const html = renderEmailShell({
    heading: `[Test] ${def.label}`,
    contentHtml: emailParagraph(
      `This is a test of the <b>${escapeHtml(def.label)}</b> alert, sent by ${escapeHtml(session.full_name)} from Admin Tools &rsaquo; Email Alerts. No real ${escapeHtml(def.label.toLowerCase())} event happened.`,
    ),
  });
  const text = `This is a test of the "${def.label}" alert, sent by ${session.full_name} from Admin Tools > Email Alerts. No real ${def.label.toLowerCase()} event happened.`;

  let sent = 0;
  let failed = 0;
  let skipped: string | null = null;
  for (const to of recipients.emails) {
    const result = await sendEmail({ to, subject: `[Test] ${def.label}`, text, html });
    if (result.ok) sent += 1;
    else if (result.kind === "skipped") skipped = skipped ?? result.reason;
    else failed += 1;
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.test_sent",
    resource_type: "staff_alert_settings",
    resource_id: null,
    metadata: {
      alert_key: parsed.data.key,
      recipients: recipients.emails.length,
      sent,
      failed,
      ...(skipped ? { skipped } : {}),
    },
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true, data: { sent, failed, skipped } };
}
