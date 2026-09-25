import { SHEET_TAB_NAMES, type Cell, type RawTabs, type TabKey } from "./types";

const MAX_ROWS_PER_TAB = 200_000;

/**
 * ONE values.batchGet over every synced tab → one consistent snapshot (spec §3).
 * UNFORMATTED_VALUE + SERIAL_NUMBER: dates arrive as serials, currency as numbers,
 * text as typed. The response is validated tab by tab; a mismatch throws.
 */
export async function readSheetTabs(opts: {
  sheetId: string;
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<RawTabs> {
  const f = opts.fetchImpl ?? fetch;
  const keys = Object.keys(SHEET_TAB_NAMES) as TabKey[];
  const qs = keys.map((k) => `ranges=${encodeURIComponent(`'${SHEET_TAB_NAMES[k]}'`)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(opts.sheetId)}/values:batchGet?${qs}` +
    "&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS";
  const res = await f(url, { headers: { authorization: `Bearer ${await opts.token()}` } });
  if (!res.ok) throw new Error(`Google Sheets read failed (${res.status})`);
  const body = (await res.json()) as { valueRanges?: Array<{ range?: string; values?: Cell[][] }> };
  const ranges = body.valueRanges ?? [];
  const out = {} as RawTabs;
  keys.forEach((k, i) => {
    const vr = ranges[i];
    const name = SHEET_TAB_NAMES[k];
    // Google quotes a range's tab name only when it needs quoting (spaces etc.).
    if (!vr?.range || !(vr.range.startsWith(`'${name}'!`) || vr.range.startsWith(`${name}!`))) {
      throw new Error(`Google Sheets returned an unexpected range for tab "${name}"`);
    }
    const values = vr.values ?? [];
    if (!Array.isArray(values) || values.length > MAX_ROWS_PER_TAB || !values.every(Array.isArray)) throw new Error(`Tab "${name}" returned an unexpected shape`);
    out[k] = values;
  });
  return out;
}
