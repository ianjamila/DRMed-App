"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  rewindWatermark,
  runAccountingSync,
} from "@/lib/accounting/sync";
import { TAB_KEYS, type SyncResult, type TabKey } from "@/lib/accounting/types";

export type AccountingActionResult =
  | { ok: true; result: SyncResult }
  | { ok: false; error: string };

const RunSchema = z.object({
  scope: z.enum(["all", ...TAB_KEYS] as [string, ...string[]]),
});

const RewindSchema = z.object({
  scope: z.enum(["all", ...TAB_KEYS] as [string, ...string[]]),
  // Manila-local datetime-local input value: 'YYYY-MM-DDTHH:MM'
  from: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
      "Pick a valid date and time.",
    ),
});

// Runs the sync for one tab or all three. Does not rewind the watermark.
export async function runSyncAction(
  _prev: AccountingActionResult | null,
  formData: FormData,
): Promise<AccountingActionResult> {
  const session = await requireAdminStaff();
  const parsed = RunSchema.safeParse({ scope: formData.get("scope") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid scope." };
  }

  const onlyKey =
    parsed.data.scope === "all" ? undefined : (parsed.data.scope as TabKey);

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "accounting.sync.requested",
    metadata: { scope: parsed.data.scope },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  try {
    const result = await runAccountingSync({
      trigger: "manual",
      onlyKey,
      actorId: session.user_id,
    });
    revalidatePath("/staff/admin/accounting");
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Rewinds the watermark, then runs the sync. Used for backfills when the live
// sheet falls out of step with the DB.
export async function rewindAndSyncAction(
  _prev: AccountingActionResult | null,
  formData: FormData,
): Promise<AccountingActionResult> {
  const session = await requireAdminStaff();
  const parsed = RewindSchema.safeParse({
    scope: formData.get("scope"),
    from: formData.get("from"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  // The datetime-local input is naive Manila time. Convert to UTC ISO so the
  // watermark stays consistent with the rest of the schema.
  const manilaIso = manilaLocalToUtcIso(parsed.data.from);
  const scope = parsed.data.scope;
  const onlyKey = scope === "all" ? undefined : (scope as TabKey);

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "accounting.resync.requested",
    metadata: { scope, from_manila: parsed.data.from, from_utc: manilaIso },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  try {
    await rewindWatermark(
      onlyKey ?? "all",
      manilaIso,
      `manual rewind by ${session.user_id} from ${parsed.data.from} (Manila)`,
    );
    const result = await runAccountingSync({
      trigger: "manual",
      onlyKey,
      actorId: session.user_id,
    });
    revalidatePath("/staff/admin/accounting");
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Treats `value` as a wall-clock Manila time (UTC+08:00, no DST in PH) and
// converts to a UTC ISO string. Equivalent to `Date.parse(value + "+08:00")`
// but explicit so the conversion is obvious to a future reader.
function manilaLocalToUtcIso(value: string): string {
  // value: 'YYYY-MM-DDTHH:MM'
  const parsed = Date.parse(`${value}:00+08:00`);
  if (Number.isNaN(parsed)) {
    throw new Error(`Could not parse Manila datetime: ${value}`);
  }
  return new Date(parsed).toISOString();
}
