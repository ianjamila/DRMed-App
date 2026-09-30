import "server-only";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";

/** Staff-only record that a patient message was NOT sent (never shown to the public caller). */
export async function auditSkippedInactiveRecipient(args: {
  sender: string;
  patientId: string;
  reason: string;
  resourceType: string;
  resourceId: string | null;
}): Promise<void> {
  try {
    await audit({
      actor_id: null,
      actor_type: "system",
      // A missing record cannot be referenced (audit_log.patient_id is an FK).
      patient_id: args.reason === "missing" ? null : args.patientId,
      action: "notification.skipped_inactive_patient",
      resource_type: args.resourceType,
      resource_id: args.resourceId,
      metadata: { sender: args.sender, reason: args.reason, patient_id: args.patientId },
    });
  } catch (e) {
    console.error("skip audit failed", e);
  }

  // A lookup failure is an outage, not a deleted patient: it must be visible
  // even when the audit insert above failed with it (0184). No PII — ids only.
  if (args.reason === "lookup_failed") {
    await reportError({
      scope: "notifications.recipient_lookup",
      error: new Error(`patient recipient lookup failed (${args.sender})`),
      metadata: { sender: args.sender, patient_id: args.patientId, resource_type: args.resourceType },
    });
  }
}
