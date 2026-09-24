import { parseName } from "../../legacy-import/name-parser";
import { parseEventDateCell } from "../dates";
import { looseKeyOf, nameNormOf, sha1Hex, tokensOf } from "../names";
import type { Cell, EncounterLine, ReviewItemInput, TabParse } from "../types";
import { assertHeaders, CONSULT_HEADERS, LAB_HEADERS } from "./headers";

const text = (c: Cell): string => (c === null || c === undefined ? "" : String(c)).trim();
const orNull = (s: string) => (s ? s : null);

/** Numbers arrive as numbers; typed amounts as "1,970" / "₱350" / "N/A". */
export function money(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? Math.round(c * 100) / 100 : null;
  const t = text(c).replace(/[₱,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}

interface Layout {
  tab: "lab" | "consult";
  sheetName: string;
  headers: ReadonlyArray<[number, number, string]>;
  firstDataRow: number;
  map: (r: Cell[], today: string) => Omit<EncounterLine,
    "tab" | "sheetRow" | "serviceDate" | "nameRaw" | "first" | "middle" | "last" | "nameNorm" | "looseKey" | "tokens" | "raw" | "rowHash">;
}

const LAB: Layout = {
  tab: "lab", sheetName: "LAB SERVICE", headers: LAB_HEADERS, firstDataRow: 2,
  map: (r, today) => ({
    controlNo: orNull(text(r[1])), testNo: orNull(text(r[2])),
    hmoRaw: orNull([text(r[4]), text(r[5])].filter(Boolean).join(" | ")),
    serviceRaw: orNull(text(r[7])), doctorRaw: null,
    basePhp: money(r[8]), finalPhp: money(r[13]), clinicFeePhp: null, revenuePhp: money(r[13]),
    paymentMethodRaw: orNull(text(r[14])), paymentDetailRaw: orNull(text(r[15])),
    releaseMediumRaw: orNull(text(r[16])), releasedOn: parseEventDateCell(r[17], today).iso,
  }),
};

const CONSULT: Layout = {
  tab: "consult", sheetName: "DOCTOR CONSULTATION", headers: CONSULT_HEADERS, firstDataRow: 2,
  map: (r) => ({
    controlNo: orNull(text(r[1])), testNo: orNull(text(r[2])),
    hmoRaw: orNull([text(r[4]), text(r[5])].filter(Boolean).join(" | ")),
    serviceRaw: null, doctorRaw: orNull(text(r[7])),
    basePhp: money(r[8]), finalPhp: money(r[11]), clinicFeePhp: money(r[12]), revenuePhp: money(r[12]),
    paymentMethodRaw: orNull(text(r[13])), paymentDetailRaw: orNull(text(r[14])),
    releaseMediumRaw: null, releasedOn: null,
  }),
};

function parseEncounterTab(layout: Layout, rows: Cell[][], opts: { today: string; windowStart: string }): TabParse<EncounterLine> {
  assertHeaders(layout.sheetName, rows, layout.headers);
  const out: EncounterLine[] = [];
  const issues: ReviewItemInput[] = [];
  let rowsRead = 0;
  let undated = 0;
  let lastDate: string | null = null;
  for (let i = layout.firstDataRow; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const nameRaw = text(r[3]);
    if (!nameRaw) continue;
    rowsRead++;
    const rowHash = sha1Hex(JSON.stringify(r));
    const d = parseEventDateCell(r[0], opts.today);
    if (d.issue) {
      issues.push({ kind: "unparseable_date", item_key: `${layout.tab}:${rowHash}`,
        payload: { tab: layout.tab, sheet_row: i + 1, column: "DATE", value: text(r[0]), name_raw: nameRaw } });
      continue;
    }
    if (!d.iso) { undated++; continue; }
    if (!lastDate || d.iso > lastDate) lastDate = d.iso;
    if (d.iso < opts.windowStart) continue;
    const name = parseName(nameRaw, null, null, null);
    const parts = { first: name.first_name, middle: name.middle_name, last: name.last_name };
    if (name.unparseable || !parts.first || !parts.last) {
      issues.push({ kind: "invalid_row", item_key: `${layout.tab}:${rowHash}`,
        payload: { tab: layout.tab, sheet_row: i + 1, reason: "name needs a surname and a first name", name_raw: nameRaw } });
      continue;
    }
    out.push({
      tab: layout.tab, sheetRow: i + 1, serviceDate: d.iso, nameRaw, ...parts,
      nameNorm: nameNormOf(parts), looseKey: looseKeyOf(parts), tokens: tokensOf(parts),
      ...layout.map(r, opts.today), raw: r, rowHash,
    });
  }
  return { rows: out, rowsRead, lastDate, undated, issues };
}

export const parseLabTab = (rows: Cell[][], opts: { today: string; windowStart: string }) => parseEncounterTab(LAB, rows, opts);
export const parseConsultTab = (rows: Cell[][], opts: { today: string; windowStart: string }) => parseEncounterTab(CONSULT, rows, opts);
