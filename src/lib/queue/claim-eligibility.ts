// Per-row claim / unclaim predicates for the lab queue (spec §6). Shared by
// the single-row actions (claimTestAction, performUnclaim) and the bulk ones
// (claimTestsAction, unclaimTestsAction) in queue/actions.ts, so a row the
// bulk bar skips is refused for exactly the reason its own button would give.
// Pure: no I/O, so vitest pins every branch.

import type { StaffSession } from "@/lib/auth/require-staff";
import {
  canClaimSection,
  claimOwnerLabel,
  claimOwnerRole,
  sectionsForRole,
} from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { labQueueGate, type LabGateVisitShape } from "@/lib/visits/lab-gate";

type Role = StaffSession["role"];

export type Eligibility = { ok: true } | { ok: false; error: string };

export interface ClaimCandidate {
  isPackageHeader: boolean;
  /**
   * `isDoctorKind(services.kind)`. Computed by the CALLER next to its read,
   * not in here: query-surfaces.test.ts checks that every lab read of
   * test_requests has a doctor-kind marker in its own enclosing function.
   */
  isDoctorLine: boolean;
  section: string | null;
  visitDeleted: boolean;
  visit: LabGateVisitShape;
}

export function evaluateClaim(c: ClaimCandidate, role: Role): Eligibility {
  // Whole-visit deletes don't cascade deleted_at onto lines — check the
  // parent so a stale tab can't claim work on a deleted visit.
  if (c.visitDeleted) {
    return { ok: false, error: "This visit was deleted from the queue." };
  }
  if (c.isPackageHeader) {
    return { ok: false, error: "Package headers cannot be claimed — they have no work." };
  }
  // A consultation has no bench step: claimed, it would sit in in_progress
  // forever. The section gate can't refuse it for admin/pathologist (doctor
  // services carry a null section, which their unrestricted scope passes).
  if (c.isDoctorLine) {
    return {
      ok: false,
      error:
        "Consultations and procedures are completed on the visit page with “Mark done”, not claimed from the lab queue.",
    };
  }
  // RLS lets every lab role (and reception) write test_requests, so the
  // queue list's section filter is UX, not the guard. reception's [] denies.
  if (
    scopeToAllowedSections(
      [{ id: "", services: { section: c.section, name: "" } }],
      sectionsForRole(role),
    ).length === 0
  ) {
    return { ok: false, error: "This test is outside the sections you can claim." };
  }
  // Single-owner sections (x-ray → x-ray technician) keep admin/pathologist out.
  const owner = claimOwnerRole(c.section);
  if (owner && !canClaimSection(role, c.section)) {
    return { ok: false, error: `Only an ${claimOwnerLabel(owner)} can claim this test.` };
  }
  // Payment gate (item 10): the worklist hides these rows, but a stale tab
  // must not start lab work on an unpaid visit.
  const gate = labQueueGate(c.visit);
  if (!gate.ok) return { ok: false, error: gate.hint };
  return { ok: true };
}

export const UNCLAIM_REFUSAL_ANY = "Only claimed, in-progress tests can be unclaimed.";
export const UNCLAIM_REFUSAL_OWN =
  "You can only unclaim a test you currently hold that has no result yet.";

export interface UnclaimCandidate {
  status: string;
  assigned_to: string | null;
}

/**
 * `ownerId` null = admin (may hand back anyone's claim); otherwise the caller
 * must be the holder. Only an in-flight claim with no uploaded result
 * (`in_progress`) can be handed back.
 */
export function evaluateUnclaim(row: UnclaimCandidate, ownerId: string | null): Eligibility {
  const ok =
    row.status === "in_progress" &&
    row.assigned_to !== null &&
    (ownerId === null || row.assigned_to === ownerId);
  if (ok) return { ok: true };
  return { ok: false, error: ownerId === null ? UNCLAIM_REFUSAL_ANY : UNCLAIM_REFUSAL_OWN };
}
