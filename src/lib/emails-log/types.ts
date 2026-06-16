// Normalized model + the audit actions that represent an email send.
// Kept free of `server-only` and the generated Database types so the
// parser stays pure and unit-testable.

export type EmailStatus = "sent" | "failed" | "no_email" | "bulk";

export type EmailType =
  | "result"
  | "booking"
  | "reminder"
  | "newsletter"
  | "registration_new"
  | "registration_existing";

export interface EmailLogEntry {
  id: number;
  sentAt: string; // created_at ISO
  type: EmailType;
  typeLabel: string;
  status: EmailStatus;
  statusLabel: string;
  patientId: string | null;
  recipientName: string | null;
  recipientDrmId: string | null;
  recipientEmail: string | null; // metadata.email.to ?? patient.email
  resendId: string | null;
  detail: string | null; // test/service name, newsletter subject, or error
  resourceType: string | null;
  resourceId: string | null;
  visitId: string | null; // results only (metadata.visit_id) — for the Visit link
  bulk?: { attempted: number; delivered: number; failed: number };
}

// The subset of an audit_log row the parser reads.
export interface EmailAuditRow {
  id: number;
  action: string;
  patient_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  created_at: string;
}

export interface PatientLite {
  id: string;
  drm_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  email: string | null;
}

// The actions surfaced by the emails-sent log, in display priority order.
export const EMAIL_ACTIONS = [
  "result.notified",
  "appointment.booked.notified",
  "appointment.reminder.sent",
  "appointment.reminder.failed",
  "newsletter.campaign.sent",
  "patient.self_registered",
  "patient.self_register.matched",
] as const;
