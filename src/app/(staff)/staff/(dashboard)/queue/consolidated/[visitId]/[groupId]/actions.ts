"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { panelRowKey } from "@/lib/queue/bulk-queue";
import { claimPanelMembers } from "@/lib/actions/queue/panel-writes";
import {
  finaliseConsolidatedReport,
  type FinaliseResult,
} from "@/lib/actions/results/finalise-consolidated";
import {
  amendConsolidatedReport,
  type AmendConsolidatedResult,
} from "@/lib/actions/results/amend-consolidated";

const ClaimSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
  testRequestIds: z.array(z.string().uuid()).min(1),
});

type ClaimOutcome = { ok: true; batchId?: string } | { ok: false; error: string };

export async function claimConsolidated(input: unknown): Promise<ClaimOutcome> {
  try {
    const { visitId, groupId, testRequestIds } = ClaimSchema.parse(input);
    const session = await requireActiveStaff();
    const supabase = await createClient();
    // Undo (bulk-select PR C item 5): a one-panel batch minted HERE, never from
    // the input — the same shape claimPanelAction writes, so
    // undoBulkQueueAction's panel branch puts the whole panel back
    // (unclaim_panel_members, all or nothing).
    const batchId = crypto.randomUUID();
    const result = await claimPanelMembers(
      session,
      supabase,
      testRequestIds,
      { visit_id: visitId, report_group_id: groupId },
      { batchId, batchSize: 1, panelKey: panelRowKey(visitId, groupId), visitId },
    );
    if (!result.ok) return result;
    revalidatePath("/staff/queue");
    return { ok: true, batchId };
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
  notifyPatient: z.boolean().optional(),
});

export async function amendConsolidated(input: unknown): Promise<AmendConsolidatedResult> {
  try {
    const parsed = AmendSchema.parse(input);
    return await amendConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
