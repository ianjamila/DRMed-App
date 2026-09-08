import "server-only";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { csvDocument } from "@/lib/csv/escape";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { Json } from "@/types/database";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

/**
 * The tail every admin report CSV shares: the in-band TRUNCATED row, the
 * `report.<key>.exported` audit row (RA 10173 — an export that discloses
 * patient data is attributable, and the metadata names the filters, never
 * the content), and the download response. Mirrors /api/admin/visits.csv.
 */
export async function reportCsvResponse(args: {
  staff: StaffSession;
  /** snake_case report key → audit action `report.<key>.exported`. */
  report: string;
  filename: string;
  /** Header row first, then one array per data row. */
  rows: readonly (readonly unknown[])[];
  truncated: boolean;
  /** The filters the export ran under. */
  filters: Record<string, Json>;
}): Promise<NextResponse> {
  const body = [...args.rows];
  // A silently truncated export reads as "that's everything". Say so in-band —
  // the reader of the file is not necessarily the person who clicked.
  if (args.truncated) {
    body.push([
      `TRUNCATED — more rows matched than the ${REPORT_EXPORT_MAX_ROWS} exported. Narrow the filters.`,
    ]);
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: args.staff.user_id,
    actor_type: "staff",
    action: `report.${args.report}.exported`,
    resource_type: "report",
    resource_id: null,
    // `report` lands AFTER the spread so no loader's filter key can ever
    // overwrite the identifier this row exists to make trustworthy.
    metadata: {
      ...args.filters,
      report: args.report,
      // rows[0] is the header row, not data.
      rows_exported: Math.max(0, args.rows.length - 1),
      truncated: args.truncated,
    },
    ip_address: ip,
    user_agent: ua,
  });

  return new NextResponse(csvDocument(body), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${args.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
