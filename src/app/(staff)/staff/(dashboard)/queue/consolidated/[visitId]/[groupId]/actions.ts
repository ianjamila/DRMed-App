"use server";

import { z } from "zod";
import { claimPanelAction } from "../../../panel-actions";
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
});

type ClaimOutcome = { ok: true; batchId?: string } | { ok: false; error: string };

export async function claimConsolidated(input: unknown): Promise<ClaimOutcome> {
  try {
    const { visitId, groupId } = ClaimSchema.parse(input);
    // Undo (bulk-select PR C item 5): the queue row's panel Claim, so the
    // SERVER resolves the panel's whole bench (a stale page can neither claim
    // a subset nor mislabel the audit rows) and mints the one-panel batch that
    // undoBulkQueueAction's panel branch puts back, all or nothing.
    return await claimPanelAction({ visitId, groupId });
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
