import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resolve a JE source_kind + source_id to an operational-record route.
 * Used by the generic /staff/admin/accounting/journal/[id] page to render
 * "View source" links.
 */
export async function resolveSourceRoute(
  sourceKind: string | null,
  sourceId: string | null
): Promise<{ label: string; href: string } | null> {
  if (!sourceKind || !sourceId) return null;
  const admin = createAdminClient();

  switch (sourceKind) {
    case "bill_post":
      return {
        label: "View bill",
        href: `/staff/admin/accounting/ap/bills/${sourceId}`,
      };

    case "bill_payment":
      return {
        label: "View payment",
        href: `/staff/admin/accounting/ap/payments/${sourceId}`,
      };

    case "payment": {
      const { data } = await admin
        .from("payments")
        .select("visit_id")
        .eq("id", sourceId)
        .maybeSingle();
      return data
        ? { label: "View visit", href: `/staff/reception/visits/${data.visit_id}` }
        : null;
    }

    case "hmo_claim_resolution": {
      // hmo_claim_resolutions has item_id → hmo_claim_items.batch_id
      const { data } = await admin
        .from("hmo_claim_resolutions")
        .select("hmo_claim_items(batch_id)")
        .eq("id", sourceId)
        .maybeSingle();
      const batchId =
        data?.hmo_claim_items &&
        !Array.isArray(data.hmo_claim_items) &&
        data.hmo_claim_items.batch_id;
      return batchId
        ? {
            label: "View HMO batch",
            href: `/staff/admin/accounting/hmo-claims/batches/${batchId}`,
          }
        : null;
    }

    case "hmo_history_opening":
      return {
        label: "View HMO history run",
        href: `/staff/admin/accounting/hmo-history/${sourceId}`,
      };

    case "reversal": {
      // For reversal source_kind, source_id is the JE id being reversed.
      return {
        label: "View reversed JE",
        href: `/staff/admin/accounting/journal/${sourceId}`,
      };
    }

    default:
      return null;
  }
}
