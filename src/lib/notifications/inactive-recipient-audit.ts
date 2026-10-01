import "server-only";
import { audit, type AuditEntry } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";

export interface InactiveSkipArgs {
  sender: string;
  patientId: string;
  reason: string;
  resourceType: string;
  resourceId: string | null;
  /** The release's bulk_batch_id, so batch Undo's changedSince guard reads this row as part of the SAME release. */
  bulkBatchId?: string | null;
}

/** The audit row for "a patient message was NOT sent" — one shape for every sender, incl. the outbox. */
export function inactiveSkipAuditEntry(args: InactiveSkipArgs): AuditEntry {
  return {
    actor_id: null,
    actor_type: "system",
    // A missing record cannot be referenced (audit_log.patient_id is an FK).
    patient_id: args.reason === "missing" ? null : args.patientId,
    action: "notification.skipped_inactive_patient",
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    metadata: {
      sender: args.sender,
      reason: args.reason,
      patient_id: args.patientId,
      ...(args.bulkBatchId ? { bulk_batch_id: args.bulkBatchId } : {}),
    },
  };
}

/** Staff-only record that a patient message was NOT sent (never shown to the public caller). */
export async function auditSkippedInactiveRecipient(args: InactiveSkipArgs): Promise<void> {
  try {
    await audit(inactiveSkipAuditEntry(args));
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
