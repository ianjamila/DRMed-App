import "server-only";
import { audit } from "@/lib/audit/log";

/** Staff-only record that a patient message was NOT sent (never shown to the public caller). */
export async function auditSkippedInactiveRecipient(args: {
  sender: string;
  patientId: string;
  reason: string;
  resourceType: string;
  resourceId: string | null;
}): Promise<void> {
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
}
