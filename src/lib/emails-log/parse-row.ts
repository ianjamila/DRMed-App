import { formatPatientName } from "@/lib/patients/format-name";
import type {
  EmailAuditRow,
  EmailLogEntry,
  EmailStatus,
  EmailType,
  PatientLite,
} from "./types";

const TYPE_LABEL: Record<EmailType, string> = {
  result: "Result ready",
  booking: "Booking confirmation",
  reminder: "Appointment reminder",
  newsletter: "Newsletter",
  registration_new: "Registration welcome",
  registration_existing: "Registration (existing)",
};

const STATUS_LABEL: Record<EmailStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  no_email: "No email on file",
  bulk: "Newsletter",
};

function typeForAction(action: string): EmailType {
  switch (action) {
    case "result.notified":
      return "result";
    case "appointment.booked.notified":
      return "booking";
    case "appointment.reminder.sent":
    case "appointment.reminder.failed":
      return "reminder";
    case "newsletter.campaign.sent":
      return "newsletter";
    case "patient.self_registered":
      return "registration_new";
    case "patient.self_register.matched":
      return "registration_existing";
    default:
      return "result"; // unreachable: callers filter to EMAIL_ACTIONS
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function parseEmailLogRow(
  row: EmailAuditRow,
  patient?: PatientLite | null,
): EmailLogEntry {
  const meta = asObject(row.metadata);
  const email = asObject(meta.email);
  const type = typeForAction(row.action);

  let status: EmailStatus;
  if (type === "newsletter") {
    status = "bulk";
  } else if (row.action === "appointment.reminder.failed") {
    status = "failed";
  } else if (email.ok === true) {
    status = "sent";
  } else if (email.skipped === true) {
    status = "no_email";
  } else if (asString(email.error)) {
    status = "failed";
  } else {
    // Legacy self-reg rows: the send was attempted but the outcome wasn't
    // recorded (forward-only capture). Treat as sent — the only path here.
    status = "sent";
  }

  let detail: string | null = null;
  if (type === "result") {
    detail = asString(meta.test_name);
  } else if (type === "newsletter") {
    detail = asString(meta.subject);
  } else if (status === "failed") {
    detail = asString(email.error) ?? asString(meta.error);
  } else if (status === "no_email") {
    detail = asString(email.reason);
  }

  const recipientEmail = asString(email.to) ?? patient?.email ?? null;
  const recipientName = patient ? formatPatientName(patient) || null : null;

  let bulk: EmailLogEntry["bulk"];
  if (type === "newsletter") {
    bulk = {
      attempted: asNumber(meta.attempted),
      delivered: asNumber(meta.delivered),
      failed: asNumber(meta.failed),
    };
  }

  return {
    id: row.id,
    sentAt: row.created_at,
    type,
    typeLabel: TYPE_LABEL[type],
    status,
    statusLabel: STATUS_LABEL[status],
    patientId: row.patient_id,
    recipientName,
    recipientDrmId: patient?.drm_id ?? null,
    recipientEmail,
    resendId: asString(email.id),
    detail,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    visitId: asString(meta.visit_id),
    bulk,
  };
}
