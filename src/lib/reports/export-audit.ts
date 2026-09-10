/**
 * The audit side of an admin report export, shared by the two mechanisms the
 * app uses to hand an admin a CSV.
 *
 * Most report CSVs are Route Handlers, so `reportCsvResponse` writes
 * `report.<key>.exported` on the server as it builds the response. The two HMO
 * claim exports cannot: they build the file in the BROWSER from the rows
 * already on screen, which is the whole point of them — they export exactly
 * what the current filters show — so there is no request to hang the row on.
 * Those call a Server Action that writes the row and nothing else.
 *
 * What that costs, stated plainly rather than papered over: for the HMO pair
 * the row count and the filters are ASSERTED by the client, not observed by
 * the server. The disclosure fact — which admin, which report, when, from
 * which IP — is still server-proven, and that is what RA 10173 attribution
 * turns on; volume and filters are supporting detail. An already-authenticated
 * admin could call the action without exporting, but the only row they can
 * forge is one incriminating themselves.
 *
 * Pure (no `server-only`) so both the metadata shape and the HMO payload
 * validation are unit-tested with no DB, matching the deps-injected shape of
 * `recordSelfRegistrationGrant`.
 */
import { z } from "zod";
import type { Json } from "@/types/database";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

/** `report.<key>.exported` — the one place the action name is spelled. */
export function reportExportedAction(report: string): string {
  return `report.${report}.exported`;
}

/**
 * The metadata every export audit row carries. `report` lands AFTER the spread
 * so no loader's filter key can ever overwrite the identifier this row exists
 * to make trustworthy.
 */
export function reportExportMetadata(args: {
  report: string;
  filters: Record<string, Json>;
  rowsExported: number;
  truncated: boolean;
}): Record<string, Json> {
  return {
    ...args.filters,
    report: args.report,
    rows_exported: args.rowsExported,
    truncated: args.truncated,
  };
}

// ============================================================
// The browser-built HMO exports
// ============================================================

/** Audit keys for the two client-side HMO CSVs. */
export const HMO_EXPORT_REPORT_KEYS = ["hmo_unbilled", "hmo_aging"] as const;
export type HmoExportReportKey = (typeof HMO_EXPORT_REPORT_KEYS)[number];

/**
 * A `"use server"` export is a callable endpoint whether or not client code
 * references it, so the payload is proved here rather than trusted: the report
 * key is one of two known reports, and the count cannot exceed the ceiling any
 * export in the app is allowed to reach.
 */
export const HmoExportAuditSchema = z.object({
  report: z.enum(HMO_EXPORT_REPORT_KEYS),
  rows_exported: z.number().int().min(0).max(REPORT_EXPORT_MAX_ROWS),
  truncated: z.boolean(),
  // The two controls on the page: the claim-kind toggle and the free-text box.
  kind: z.enum(["all", "lab", "doctor"]),
  search: z.string().max(200),
});

export type HmoExportAudit = z.infer<typeof HmoExportAuditSchema>;

export interface HmoExportAuditDeps {
  audit: (entry: {
    actor_id: string;
    actor_type: "staff";
    action: string;
    resource_type: string;
    resource_id: null;
    metadata: Record<string, Json>;
    ip_address: string | null;
    user_agent: string | null;
  }) => Promise<void>;
  ipAndAgent: () => Promise<{ ip: string | null; ua: string | null }>;
}

/**
 * Write the export audit row for a browser-built HMO CSV. Deliberately mirrors
 * `reportCsvResponse`'s row field for field, so a reader of `audit_log` cannot
 * tell — and does not need to care — which mechanism produced the file.
 */
export async function recordHmoExportAudit(
  deps: HmoExportAuditDeps,
  input: { actorId: string; audit: HmoExportAudit },
): Promise<void> {
  const { ip, ua } = await deps.ipAndAgent();
  await deps.audit({
    actor_id: input.actorId,
    actor_type: "staff",
    action: reportExportedAction(input.audit.report),
    resource_type: "report",
    resource_id: null,
    metadata: reportExportMetadata({
      report: input.audit.report,
      // Recorded as the admin's own filter state, which is what makes the row
      // useful when someone asks "what did that export contain?".
      filters: { kind: input.audit.kind, search: input.audit.search },
      rowsExported: input.audit.rows_exported,
      truncated: input.audit.truncated,
    }),
    ip_address: ip,
    user_agent: ua,
  });
}
