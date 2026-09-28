import "server-only";

import { getServiceAccountToken } from "../google/service-account-token";
import type { SheetRow } from "./types";

// Minimal Google Sheets client. Avoids the `googleapis` dependency:
// - Trade the service account key for a short-lived OAuth access token
//   (shared helper in src/lib/google/service-account-token.ts)
// - Call sheets.googleapis.com directly with fetch

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface AppendRowsArgs {
  serviceAccountJson: string;
  sheetId: string;
  tabName: string;
  rows: SheetRow[];
}

export interface AppendRowsResult {
  updatedRange: string | null;
  appendedRows: number;
}

// Appends rows to the bottom of the named tab. Uses USER_ENTERED so currency
// formatting renders the way the accountant expects (₱-prefixed, formulas
// evaluated). INSERT_ROWS keeps the appended rows separate from any tracked
// table on the tab.
//
// Range is the tab name only (no cell ref) so Google's table-detection
// considers the whole sheet — using `Tab!A1` gets confused by multi-row or
// merged-cell headers and can insert above them.
export async function appendRowsToTab({
  serviceAccountJson,
  sheetId,
  tabName,
  rows,
}: AppendRowsArgs): Promise<AppendRowsResult> {
  if (rows.length === 0) {
    return { updatedRange: null, appendedRows: 0 };
  }

  const accessToken = await getServiceAccountToken(serviceAccountJson, SPREADSHEETS_SCOPE);
  const range = encodeURIComponent(tabName);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Google Sheets append failed (${res.status}) for tab "${tabName}": ${text}`,
    );
  }

  const data = (await res.json()) as {
    updates?: { updatedRange?: string; updatedRows?: number };
  };

  return {
    updatedRange: data.updates?.updatedRange ?? null,
    appendedRows: data.updates?.updatedRows ?? rows.length,
  };
}
