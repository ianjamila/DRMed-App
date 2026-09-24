// The alert emails DRMed sends to STAFF, and who gets each one by default.
// Admin Tools › Email Alerts (/staff/admin/settings/alerts) lets an admin turn
// an alert off, switch individual staff on or off, and add extra addresses
// (migration 0155). Client-safe: the settings page, the senders and the tests
// all read this one registry.
//
// STAFF_ALERT_KEYS is pinned to 0155's CHECK constraint by staff-alerts.test.ts
// — add an alert in BOTH places, plus a seed row in a migration.
import type { StaffSession } from "@/lib/auth/require-staff";

type StaffRole = StaffSession["role"];

export const STAFF_ALERT_KEYS = ["website_message", "template_health", "dedup_digest"] as const;
export type StaffAlertKey = (typeof STAFF_ALERT_KEYS)[number];

export interface StaffAlertDef {
  key: StaffAlertKey;
  label: string;
  /** What the email is about and when it goes out, in plain words. */
  description: string;
  /** Staff in these roles receive it unless an admin switches them off. */
  defaultRoles: ReadonlyArray<StaffRole>;
  /** The audit_log action written when the alert goes out — read back for "Last sent". */
  sentAction: string;
}

export const STAFF_ALERTS: Record<StaffAlertKey, StaffAlertDef> = {
  website_message: {
    key: "website_message",
    label: "New website message",
    description:
      "Sent the moment someone writes in through the Contact page on drmed.ph. It shows the sender's first name and subject only — staff sign in to read the message.",
    defaultRoles: ["reception", "admin"],
    sentAction: "contact_message.alert_sent",
  },
  template_health: {
    key: "template_health",
    label: "Result template problems",
    description:
      "The daily and weekly check of lab result templates. Sent only when it finds a problem (a broken or missing template, or the daily check itself stopped running).",
    defaultRoles: ["admin"],
    sentAction: "system.template_health.alert_sent",
  },
  dedup_digest: {
    key: "dedup_digest",
    label: "Possible duplicate patients",
    description:
      "A daily digest of patient records that look like the same person, with a link to review and merge them. Sent only on days when there is something to review.",
    defaultRoles: ["admin"],
    sentAction: "system.dedup_digest.sent",
  },
};

export const STAFF_ALERT_LIST: ReadonlyArray<StaffAlertDef> = STAFF_ALERT_KEYS.map((k) => STAFF_ALERTS[k]);

export function isStaffAlertKey(value: unknown): value is StaffAlertKey {
  return typeof value === "string" && (STAFF_ALERT_KEYS as ReadonlyArray<string>).includes(value);
}

export const ALERT_EXTRA_EMAIL_MAX = 254;

// ---------------------------------------------------------------------------
// Who actually receives an alert — pure, so the settings page's "N people get
// this" summary and the senders cannot disagree.
// ---------------------------------------------------------------------------

export interface AlertStaffMember {
  id: string;
  role: StaffRole;
  /** The staff member's sign-in email; null when their account has none. */
  email: string | null;
}

export interface AlertExtraAddress {
  email: string;
  subscribed: boolean;
}

export interface AlertRecipientInput {
  enabled: boolean;
  defaultRoles: ReadonlyArray<StaffRole>;
  /** ACTIVE staff only — the caller filters out deactivated/deleted accounts. */
  staff: ReadonlyArray<AlertStaffMember>;
  /** staff_id → subscribed, for staff an admin switched explicitly. */
  overrides: ReadonlyMap<string, boolean>;
  extras: ReadonlyArray<AlertExtraAddress>;
}

export interface AlertRecipients {
  enabled: boolean;
  /** Deduplicated (case-insensitive), in a stable order: staff first, then extras. */
  emails: string[];
  /** Staff switched on, including any without an email on file. */
  staffOn: string[];
  /** Switched-on staff whose account has no email — shown as a warning. */
  staffWithoutEmail: string[];
}

export function isStaffSubscribed(
  member: Pick<AlertStaffMember, "id" | "role">,
  defaultRoles: ReadonlyArray<StaffRole>,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const explicit = overrides.get(member.id);
  return explicit ?? defaultRoles.includes(member.role);
}

export function computeAlertRecipients(input: AlertRecipientInput): AlertRecipients {
  const staffOn: string[] = [];
  const staffWithoutEmail: string[] = [];
  const emails: string[] = [];
  const seen = new Set<string>();
  const add = (email: string) => {
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    emails.push(email.trim());
  };
  for (const m of input.staff) {
    if (!isStaffSubscribed(m, input.defaultRoles, input.overrides)) continue;
    staffOn.push(m.id);
    if (m.email) add(m.email);
    else staffWithoutEmail.push(m.id);
  }
  for (const x of input.extras) {
    if (x.subscribed) add(x.email);
  }
  if (!input.enabled) return { enabled: false, emails: [], staffOn, staffWithoutEmail };
  return { enabled: true, emails, staffOn, staffWithoutEmail };
}
