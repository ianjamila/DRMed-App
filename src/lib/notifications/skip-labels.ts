import { humaniseCode } from "@/lib/format/humanise-code";

// Plain words for Cron Health's "Patient messages not sent" (0184). Keys are
// the `sender` / `reason` values auditSkippedInactiveRecipient records.
export const SKIP_SENDER_LABEL: Record<string, string> = {
  "notify-released": "Result ready (one test)",
  "notify-released-bulk": "Results ready (several tests)",
  "notify-corrected": "Corrected result notice",
  "notify-appointment-booked": "Booking confirmation",
  "notify-appointment-reminder": "Appointment reminder",
  register: "Registration email",
  "find-my-id": "Find my DRM-ID email",
  "send-statement-email": "Statement email",
  "patient-merge": "Records combined notice",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  deleted: "Record deleted",
  merged: "Record merged into another",
  missing: "Record not found",
  lookup_failed: "Could not check the record",
  walk_in: "No patient record (walk-in)",
};

export const skipSenderLabel = (key: string) => SKIP_SENDER_LABEL[key] ?? humaniseCode(key.replace(/-/g, "_"));
export const skipReasonLabel = (key: string) => SKIP_REASON_LABEL[key] ?? humaniseCode(key);
