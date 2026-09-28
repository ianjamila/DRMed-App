"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { isISODate } from "@/lib/dates/manila";
import type { Json } from "@/types/database";
import {
  parseAdSpendText,
  REJECT_REASON_LABEL,
  type AdSpendSaveResult,
} from "@/lib/marketing/ad-spend-import";

export type RemoveAdSpendResult = { ok: true; data: { deleted: number } } | { ok: false; error: string };

export async function removeAdSpendAction(_prev: RemoveAdSpendResult | null, formData: FormData): Promise<RemoveAdSpendResult> {
  await requireAdminStaff();
  const platform = String(formData.get("platform") ?? "");
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  if (platform !== "meta" && platform !== "google") return { ok: false, error: "Pick Meta or Google." };
  if (!isISODate(from) || !isISODate(to) || from > to) return { ok: false, error: "Pick a start date on or before the end date." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ad_spend_delete", { p_platform: platform, p_from: from, p_to: to });
  if (error) {
    console.error("[ad-spend] delete failed", error.code);
    return { ok: false, error: "Couldn't remove the saved spend. Nothing was removed — try again." };
  }
  revalidatePath("/staff/marketing/patients");
  return { ok: true, data: { deleted: Number(data ?? 0) } };
}

const MAX_CSV_CHARS = 5_000_000;

// Re-parses the RAW CSV text on the server (plan P14) — rows computed in the
// browser's looser in-browser parser (ad-dashboard.tsx) are never trusted.
// All-or-nothing: `ad_spend_import` (0189) upserts every row in one
// transaction and is itself admin-gated (`has_role`) and audited
// (`ad_spend.imported`), so this action does not write its own audit row;
// it still checks for an admin up front so a non-admin never uploads a file.
export async function saveAdSpendAction(csvText: string): Promise<AdSpendSaveResult> {
  await requireAdminStaff();
  if (typeof csvText !== "string" || csvText.trim() === "") return { ok: false, error: "The file is empty." };
  if (csvText.length > MAX_CSV_CHARS) return { ok: false, error: "The file is larger than 5 MB — export a shorter date range." };

  // Codex recheck #2: the whole locateHeader + Papa.parse + error-mapping
  // pipeline lives in ad-spend-import.ts's parseAdSpendText, so this action
  // never re-derives a row-index set that can drift from PapaParse's real
  // behaviour (a Quotes-type error's row index does not point into
  // parsed.data the way a FieldMismatch error's does).
  const result = parseAdSpendText(csvText);
  if (!result.ok) return { ok: false, error: result.error };
  const rejectedTotal = result.rejected.reduce((s, r) => s + r.count, 0);
  const rejected = result.rejected.map((r) => ({ reason: REJECT_REASON_LABEL[r.reason], count: r.count }));
  if (result.rows.length === 0) {
    return { ok: true, data: { inserted: 0, replaced: 0, days: 0, currencyAssumed: result.currencyAssumed, rejected } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ad_spend_import", {
    p_upload_id: randomUUID(),
    p_rows: result.rows as unknown as Json,
    p_rejected_count: rejectedTotal,
  });
  if (error || !data) {
    console.error("[ad-spend] import failed", error?.code);
    // Codex recheck #1 (DB half): the RPC refuses a representation change
    // (campaign total <-> per ad) when the file also had rejected rows —
    // map its tagged message to clean user text rather than showing raw PG
    // text or the generic failure below.
    if (error?.code === "22023" && error.message?.includes("[breakdown change]")) {
      return {
        ok: false,
        error: "This file changes how saved spend is broken down (campaign total vs per ad) but some rows were rejected — fix them and upload again. Nothing was saved.",
      };
    }
    return { ok: false, error: "Couldn't save the ad spend. Nothing was saved — try again." };
  }
  const counts = data as { inserted: number; replaced: number; days: number };
  revalidatePath("/staff/marketing/patients");
  return { ok: true, data: { ...counts, currencyAssumed: result.currencyAssumed, rejected } };
}
