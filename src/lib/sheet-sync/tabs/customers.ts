import { parseName } from "../../legacy-import/name-parser";
import { normalizePhone } from "../../legacy-import/phone-normalizer";
import { mapReleaseMedium, mapSeniorPwdKind, mapSex } from "../../legacy-import/vocabulary-mapper";
import { parseDobCell, parseEventDateCell } from "../dates";
import { linkKeyOf, looseKeyOf, nameNormOf, phone10, sha1Hex, sourceKeyOf, tokensOf } from "../names";
import { mapAnswer } from "../referral-mapper";
import type { Cell, CustomerRow, ReviewItemInput, TabParse } from "../types";
import { assertHeaders, CUSTOMER_HEADERS } from "./headers";

const text = (c: Cell): string => (c === null || c === undefined ? "" : String(c)).trim();
const orNull = (s: string) => (s ? s : null);

function newRepeatOf(c: Cell): "new" | "repeat" | null {
  const t = text(c).toUpperCase();
  if (t === "NEW") return "new";
  if (t === "REPEAT" || t === "OLD") return "repeat";
  return null;
}

export function parseCustomersTab(
  rows: Cell[][],
  opts: { today: string; aliases: ReadonlyMap<string, string> },
): TabParse<CustomerRow> {
  assertHeaders("CUSTOMER LIST2", rows, CUSTOMER_HEADERS);
  const header = (rows[0] ?? []).map((h) => String(h ?? ""));
  const byKey = new Map<string, CustomerRow>();
  const issues: ReviewItemInput[] = [];
  let rowsRead = 0;
  let undated = 0;
  let lastDate: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const fullName = text(r[4]);
    if (!fullName && !text(r[0]) && !text(r[1])) continue;
    rowsRead++;
    const sheetRow = i + 1;
    const rowHash = sha1Hex(JSON.stringify(r));
    const name = parseName(fullName, text(r[0]), text(r[1]), text(r[2]));
    if (name.unparseable || !name.first_name || !name.last_name) {
      issues.push({ kind: "invalid_row", item_key: `customers:${rowHash}`,
        payload: { tab: "customers", sheet_row: sheetRow, reason: "name needs a surname and a first name", name_raw: fullName } });
      continue;
    }
    const parts = { first: name.first_name, middle: name.middle_name, last: name.last_name };
    const dobP = parseDobCell(r[6], opts.today);
    const regP = parseEventDateCell(r[20], opts.today);
    const phone = normalizePhone(text(r[11]));
    const answer = mapAnswer(r[16], opts.aliases);
    const release = mapReleaseMedium(text(r[18]));
    const nameNorm = nameNormOf(parts);
    const p10 = phone10(r[11]);
    const sourceKey = sourceKeyOf(nameNorm, p10, dobP.iso, regP.iso);

    const existing = byKey.get(sourceKey);
    if (existing) {
      existing.dupCount++;
      continue;
    }
    if (regP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:registered_on`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Timestamp", value: text(r[20]), name_raw: fullName } });
    if (dobP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:dob`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Date of Birth", value: text(r[6]), name_raw: fullName } });
    if (regP.iso === null) undated++;
    if (regP.iso && (!lastDate || regP.iso > lastDate)) lastDate = regP.iso;

    const kind = mapSeniorPwdKind(text(r[13]));
    const seniorNumber = orNull(text(r[14]));
    const address = [text(r[8]), text(r[9]), text(r[10])].filter(Boolean).join(", ").replace(/\s+/g, " ");
    const raw: Record<string, string> = {};
    header.forEach((h, c) => { if (h) raw[h] = text(r[c]); });

    byKey.set(sourceKey, {
      sheetRow, fullNameRaw: fullName, ...parts, nameNorm, looseKey: looseKeyOf(parts),
      linkKey: linkKeyOf(nameNorm, dobP.iso), tokens: tokensOf(parts),
      phoneE164: phone.e164, phone10: p10, email: orNull(text(r[12]).toLowerCase()), dob: dobP.iso,
      sex: mapSex(text(r[5])), address: orNull(address),
      referredByDoctor: orNull(text(r[15])), referredByRaw: orNull(text(r[17])),
      releaseMedium: release.id, releaseMediumRaw: orNull(text(r[18])),
      seniorKind: kind && seniorNumber ? kind : null, seniorNumber: kind && seniorNumber ? seniorNumber : null,
      registeredOn: regP.iso, sourceRaw: text(r[16]), sourceNorm: answer.norm, referralSourceId: answer.id,
      unmappedSource: answer.unmapped, newRepeat: newRepeatOf(r[19]), raw, rowHash, sourceKey, dupCount: 1,
    });
  }
  return { rows: [...byKey.values()], rowsRead, lastDate, undated, issues };
}
