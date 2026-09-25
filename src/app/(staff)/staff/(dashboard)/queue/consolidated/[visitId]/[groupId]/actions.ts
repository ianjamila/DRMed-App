"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { canClaimSection, sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import {
  finaliseConsolidatedReport,
  type FinaliseResult,
} from "@/lib/actions/results/finalise-consolidated";
import {
  amendConsolidatedReport,
  type AmendConsolidatedResult,
} from "@/lib/actions/results/amend-consolidated";

const ClaimSchema = z.object({
  testRequestIds: z.array(z.string().uuid()).min(1),
});

export async function claimConsolidated(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { testRequestIds } = ClaimSchema.parse(input);
    const session = await requireActiveStaff();
    const supabase = await createClient();

    // Same defense-in-depth pre-read as claimTestAction: a stale tab must not
    // start lab work on a deleted entry, a deleted visit, or a visit still
    // waiting for payment (item 10, decision 1).
    const { data: members } = await supabase
      .from("test_requests")
      .select(
        "id, deleted_at, services!inner ( section, name ), visits!inner ( deleted_at, payment_status, hmo_provider_id )",
      )
      .in("id", testRequestIds);
    if (!members || members.length !== testRequestIds.length) {
      return { ok: false, error: "Some tests in this report were not found." };
    }
    if (members.some((m) => m.visits.deleted_at !== null)) {
      return { ok: false, error: "This visit was deleted from the queue." };
    }
    if (members.some((m) => m.deleted_at !== null)) {
      return {
        ok: false,
        error: "Some tests in this report were deleted from the queue.",
      };
    }
    for (const m of members) {
      const gate = labQueueGate(m.visits);
      if (!gate.ok) return { ok: false, error: gate.hint };
    }
    // Section gate, server-side — same rule as claimTestAction: RLS is
    // role-only, so the caller must be allowed every section in the report.
    if (
      scopeToAllowedSections(members, sectionsForRole(session.role)).length !==
      members.length
    ) {
      return {
        ok: false,
        error: "This report is outside the sections you can claim.",
      };
    }
    // Single-owner sections (x-ray → x-ray technician) — the same rule as
    // claimTestAction, so the two claim paths cannot drift.
    if (members.some((m) => !canClaimSection(session.role, m.services.section))) {
      return {
        ok: false,
        error: "Part of this report can only be claimed by another role.",
      };
    }

    // Only claim if every member is still 'requested' — concurrency-safe,
    // matching claimTestAction's semantics for single tests.
    const { data, error } = await supabase
      .from("test_requests")
      .update({
        assigned_to: session.user_id,
        status: "in_progress",
        started_at: new Date().toISOString(),
      })
      .in("id", testRequestIds)
      .eq("status", "requested")
      .is("deleted_at", null)
      .select("id");
    if (error) {
      return { ok: false, error: translatePgError(error) };
    }
    if ((data ?? []).length !== testRequestIds.length) {
      return {
        ok: false,
        error: "Some tests in this report were already claimed or changed status.",
      };
    }

    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: null,
      metadata: { test_request_ids: testRequestIds, grouped: true },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });

    revalidatePath("/staff/queue");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const FinaliseSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
  testRequestIds: z.array(z.string().uuid()).min(1),
  values: z.array(
    z.object({
      parameter_id: z.string().uuid(),
      numeric_value_si: z.number().nullable(),
      numeric_value_conv: z.number().nullable(),
    }),
  ),
});

export async function finaliseConsolidated(
  input: unknown,
): Promise<FinaliseResult> {
  try {
    const parsed = FinaliseSchema.parse(input);
    return await finaliseConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const AmendSchema = z.object({
  resultId: z.string().uuid(),
  expectedAmendmentCount: z.number().int().min(0),
  reason: z.string(),
  values: z.array(
    z.object({
      parameter_id: z.string().uuid(),
      numeric_value_si: z.number().nullable(),
      numeric_value_conv: z.number().nullable(),
    }),
  ),
});

export async function amendConsolidated(input: unknown): Promise<AmendConsolidatedResult> {
  try {
    const parsed = AmendSchema.parse(input);
    return await amendConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
