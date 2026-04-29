import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

type ActorType = "staff" | "patient" | "system" | "anonymous";

export interface AuditEntry {
  actor_id: string | null;
  actor_type: ActorType;
  patient_id?: string | null;
  action: string;
  resource_type?: string | null;
  resource_id?: string | null;
  metadata?: Json | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_log").insert({
    actor_id: entry.actor_id,
    actor_type: entry.actor_type,
    patient_id: entry.patient_id ?? null,
    action: entry.action,
    resource_type: entry.resource_type ?? null,
    resource_id: entry.resource_id ?? null,
    metadata: entry.metadata ?? null,
    ip_address: entry.ip_address ?? null,
    user_agent: entry.user_agent ?? null,
  });

  if (error) {
    // Audit-log failures must not block user-facing operations.
    // Sentry hookup comes in Phase 8.
    console.error("audit log insert failed", { entry, error });
  }
}
