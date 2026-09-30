// The WHOLE membership of a consolidated chemistry panel on the lab queue.
//
// The queue list pages by test row BEFORE it folds a visit's chemistry tests
// into one card, so a card can show only part of its panel — and the Unclaimed
// tab hides a member someone already claimed. Every panel action (Claim,
// Unclaim, Delete — row buttons and the bulk bar) therefore decides on, and
// acts on, the full membership read here, never on the ids a page rendered.
// The page and the server actions share this module, so a button the page
// shows is one the server accepts for the same reason.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canClaimSection } from "@/lib/auth/role-sections";
import type { StaffSession } from "@/lib/auth/require-staff";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { partitionConsolidatedMembers } from "@/lib/results/consolidated-reports";
import { hasOpenHmoClaim, testDeletability } from "@/lib/visits/deletion";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { panelRowKey } from "@/lib/queue/bulk-queue";

export interface PanelRef {
  visitId: string;
  groupId: string;
}

export interface PanelMember {
  id: string;
  status: string;
  assignedTo: string | null;
  section: string | null;
  parentId: string | null;
  visitPaymentStatus: string;
  visitHmoProviderId: string | null;
  hasOpenHmoClaim: boolean;
  resultId: string | null;
  hasPdf: boolean;
}

export interface PanelState {
  /** Live members still on the bench (no finished report) — what Claim / Unclaim act on. */
  benchIds: string[];
  /** Each bench member's holder, parallel to benchIds (what Unclaim sends as "the holder I saw"). */
  benchHolders: Array<string | null>;
  /** Every live member — what Delete acts on (a panel is deleted whole). */
  allIds: string[];
  /** The one holder of every bench member, when there is exactly one (null when unheld or split). */
  holder: string | null;
  claimable: boolean;
  unclaimable: boolean;
  deletable: boolean;
}

/**
 * Pure: what the viewer may do with a panel, from its FULL membership.
 * - Claim: every bench member requested, unassigned, and in a section the
 *   role may claim (claim_panel_members, 0191, re-proves the first two).
 * - Unclaim: every bench member in progress under ONE holder, and that holder
 *   is the viewer unless the viewer is an admin (unclaim_panel_members, 0191).
 * - Delete: every live member passes testDeletability (the 0125/0147/0172
 *   guard triggers re-prove it, per visit, atomically).
 */
export function summarizePanel(
  members: readonly PanelMember[],
  viewer: {
    role: StaffSession["role"];
    userId: string | null;
    sharedReportIds: ReadonlySet<string>;
  },
): PanelState {
  const { encodeIds } = partitionConsolidatedMembers(
    members.map((m) => ({ id: m.id, status: m.status, resultId: m.resultId, hasPdf: m.hasPdf })),
  );
  const benchSet = new Set(encodeIds);
  const bench = members.filter((m) => benchSet.has(m.id));
  const holders = new Set(bench.map((m) => m.assignedTo));
  const holder = holders.size === 1 ? ([...holders][0] ?? null) : null;

  // The lab payment gate (labQueueGate) as claimPanelMembers applies it: the
  // worklist tabs already hide unpaid visits, but Pending release does not,
  // and a panel there can have a new bench test on an unpaid visit.
  const claimable =
    bench.length > 0 &&
    bench.every(
      (m) =>
        m.status === "requested" &&
        m.assignedTo === null &&
        canClaimSection(viewer.role, m.section) &&
        labQueueGate({ payment_status: m.visitPaymentStatus, hmo_provider_id: m.visitHmoProviderId })
          .ok,
    );
  // Every bench member in progress; a non-admin must hold ALL of them, an
  // admin may hand back a panel split between people (per-member holders).
  const unclaimable =
    bench.length > 0 &&
    bench.every((m) => m.status === "in_progress" && m.assignedTo !== null) &&
    (viewer.role === "admin" || bench.every((m) => m.assignedTo === viewer.userId));
  const deletable =
    members.length > 0 &&
    members.every(
      (m) =>
        testDeletability(viewer.role, {
          status: m.status,
          deleted_at: null,
          parent_id: m.parentId,
          visit_payment_status: m.visitPaymentStatus,
          visit_deleted_at: null,
          has_open_hmo_claim: m.hasOpenHmoClaim,
          has_shared_report: viewer.sharedReportIds.has(m.id),
        }).ok,
    );

  return {
    benchIds: bench.map((m) => m.id),
    benchHolders: bench.map((m) => m.assignedTo),
    allIds: members.map((m) => m.id),
    holder,
    claimable,
    unclaimable,
    deletable,
  };
}

const PAGE = 1000;

/**
 * Every live member of each (visit, report group) panel, keyed by panelRowKey.
 * Same scope as the panel page's member read: report-group-scoped, package
 * headers out, cancelled out, soft-deleted lines AND visits out. Pages through
 * the result so PostgREST's row cap can never silently truncate a panel.
 */
export async function fetchPanelMembers(
  client: SupabaseClient<Database>,
  panels: readonly PanelRef[],
): Promise<{ ok: true; byKey: Map<string, PanelMember[]> } | { ok: false; error: string }> {
  const byKey = new Map<string, PanelMember[]>();
  if (panels.length === 0) return { ok: true, byKey };
  const wanted = new Set(panels.map((p) => panelRowKey(p.visitId, p.groupId)));
  for (const key of wanted) byKey.set(key, []);
  const visitIds = [...new Set(panels.map((p) => p.visitId))];
  const groupIds = [...new Set(panels.map((p) => p.groupId))];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("test_requests")
      .select(
        `id, status, assigned_to, visit_id, parent_id,
         hmo_claim_items ( batch_voided ),
         services!inner ( section, report_group_id, kind ),
         visits!inner ( payment_status, hmo_provider_id, deleted_at ),
         result_test_requests ( result_id, results ( storage_path ) )`,
      )
      .in("visit_id", visitIds)
      .in("services.report_group_id", groupIds)
      // A report group never holds a doctor line; stated so the lab/doctor
      // split is explicit on this read (query-surfaces.test.ts).
      .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      .eq("is_package_header", false)
      .neq("status", "cancelled")
      .is("deleted_at", null)
      .is("visits.deleted_at", null)
      .order("requested_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: error.message };
    for (const r of data ?? []) {
      const svc = Array.isArray(r.services) ? r.services[0] : r.services;
      const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
      if (!svc?.report_group_id || !visit) continue;
      const key = panelRowKey(r.visit_id, svc.report_group_id);
      const list = byKey.get(key);
      if (!list) continue; // same visit, a different panel than the one asked for
      const link = Array.isArray(r.result_test_requests)
        ? (r.result_test_requests[0] ?? null)
        : (r.result_test_requests ?? null);
      const result = link
        ? Array.isArray(link.results)
          ? (link.results[0] ?? null)
          : (link.results ?? null)
        : null;
      list.push({
        id: r.id,
        status: r.status,
        assignedTo: r.assigned_to,
        section: svc.section,
        parentId: r.parent_id,
        visitPaymentStatus: visit.payment_status,
        visitHmoProviderId: visit.hmo_provider_id,
        hasOpenHmoClaim: hasOpenHmoClaim(r.hmo_claim_items),
        resultId: link?.result_id ?? null,
        hasPdf: Boolean(result?.storage_path),
      });
    }
    if ((data ?? []).length < PAGE) break;
  }
  return { ok: true, byKey };
}
