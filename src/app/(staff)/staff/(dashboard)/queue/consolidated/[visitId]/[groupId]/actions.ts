"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
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

    const { error } = await supabase
      .from("test_requests")
      .update({
        assigned_to: session.user_id,
        status: "in_progress",
      })
      .in("id", testRequestIds)
      .in("status", ["requested", "in_progress"]);
    if (error) {
      return { ok: false, error: translatePgError(error) };
    }

    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "test_request.claim",
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
