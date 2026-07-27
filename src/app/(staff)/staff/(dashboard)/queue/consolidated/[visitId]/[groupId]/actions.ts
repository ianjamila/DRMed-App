"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { labQueueGate } from "@/lib/visits/lab-gate";
import {
  finaliseConsolidatedReport,
  type FinaliseResult,
} from "@/lib/actions/results/finalise-consolidated";

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
        "id, deleted_at, visits!inner ( deleted_at, payment_status, hmo_provider_id )",
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
