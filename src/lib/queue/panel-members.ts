import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { panelKey, type PanelRef } from "./bulk-queue";

export interface PanelMember {
  id: string;
  visit_id: string;
  status: string;
  assigned_to: string | null;
  started_at: string | null;
  is_package_header: boolean;
  services: { kind: string; section: string | null; name: string; report_group_id: string | null };
  visits: { deleted_at: string | null; payment_status: string; hmo_provider_id: string | null };
}

/**
 * Every live bench member of each requested panel — the same set the panel's
 * own page claims and unclaims (queue/consolidated/[visitId]/[groupId]/page.tsx:
 * not a package header, not cancelled, not deleted, still requested or in
 * progress). A panel with no bench members maps to [] (callers report it).
 * `services!inner` makes the report_group filter a real filter — PostgREST
 * silently ignores a filter on a LEFT-joined embed.
 */
export async function loadPanelMembers(
  supabase: SupabaseClient<Database>,
  panels: readonly PanelRef[],
): Promise<{ ok: true; members: Map<string, PanelMember[]> } | { ok: false; error: string }> {
  const members = new Map<string, PanelMember[]>(panels.map((p) => [p.key, []]));
  if (panels.length === 0) return { ok: true, members };
  const { data, error } = await supabase
    .from("test_requests")
    .select(
      "id, visit_id, status, assigned_to, started_at, is_package_header, services!inner ( kind, section, name, report_group_id ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
    )
    .in("visit_id", [...new Set(panels.map((p) => p.visitId))])
    .in("services.report_group_id", [...new Set(panels.map((p) => p.groupId))])
    .eq("is_package_header", false)
    .in("status", ["requested", "in_progress"])
    .is("deleted_at", null)
    .returns<PanelMember[]>();
  if (error) return { ok: false, error: error.message };
  for (const row of data ?? []) {
    const groupId = row.services.report_group_id;
    if (!groupId) continue;
    members.get(panelKey(row.visit_id, groupId))?.push(row);
  }
  return { ok: true, members };
}
