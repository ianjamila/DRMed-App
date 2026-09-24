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

/** Strip trailing commas/whitespace a cell may itself end with (spec Task 4). */
const trimTrailingComma = (s: string) => s.replace(/(,\s*)+$/g, "").trim();

/** Same shape as the May importer's address join, plus per-part comma trimming
 * so a cell that itself ends in a comma does not leave a ", ," run behind. */
function buildAddress(parts: readonly string[]): string | null {
  const joined = parts
    .map(trimTrailingComma)
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/(,\s*)+$/g, "");
  return orNull(joined);
}

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
      // Identifying cells only (spec Task 1) — a formula column like Age (col
      // 7) or an unrelated edit elsewhere in the row must not reopen a
      // dismissed review item.
      const stableKey = sha1Hex(
        [fullName, text(r[0]), text(r[1]), text(r[2]), text(r[6]), text(r[20])].join("␟"),
      );
      issues.push({ kind: "invalid_row", item_key: `customers:${stableKey}`,
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

    const kind = mapSeniorPwdKind(text(r[13]));
    const seniorNumber = orNull(text(r[14]));
    const email = orNull(text(r[12]).toLowerCase());
    const sex = mapSex(text(r[5]));
    const address = buildAddress([text(r[8]), text(r[9]), text(r[10])]);
    const referredByDoctor = orNull(text(r[15]));
    const referredByRaw = orNull(text(r[17]));
    const releaseMediumRaw = orNull(text(r[18]));
    const newRepeat = newRepeatOf(r[19]);
    const seniorKind = kind && seniorNumber ? kind : null;
    const pairedSeniorNumber = kind && seniorNumber ? seniorNumber : null;

    const existing = byKey.get(sourceKey);
    if (existing) {
      existing.dupCount++;
      // Fill any NULL field of the kept row from this later duplicate; never
      // overwrite a value the kept row already has (spec Task 3). Skip: date
      // review items for the duplicate's own junk timestamps — it shares the
      // kept row's item_key via sourceKey, so nothing new to dismiss.
      if (existing.email === null) existing.email = email;
      if (existing.sex === null) existing.sex = sex;
      if (existing.address === null) existing.address = address;
      if (existing.referredByDoctor === null) existing.referredByDoctor = referredByDoctor;
      if (existing.referredByRaw === null) existing.referredByRaw = referredByRaw;
      if (existing.releaseMedium === null) existing.releaseMedium = release.id;
      if (existing.releaseMediumRaw === null) existing.releaseMediumRaw = releaseMediumRaw;
      if (existing.seniorKind === null && existing.seniorNumber === null) {
        existing.seniorKind = seniorKind;
        existing.seniorNumber = pairedSeniorNumber;
      }
      if (existing.sourceNorm === "") {
        existing.sourceRaw = text(r[16]);
        existing.sourceNorm = answer.norm;
        existing.referralSourceId = answer.id;
        existing.unmappedSource = answer.unmapped;
      }
      if (existing.newRepeat === null) existing.newRepeat = newRepeat;
      continue;
    }
    if (regP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:registered_on`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Timestamp", value: text(r[20]), name_raw: fullName, reason: regP.issue } });
    if (dobP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:dob`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Date of Birth", value: text(r[6]), name_raw: fullName, reason: dobP.issue } });
    if (regP.iso === null) undated++;
    if (regP.iso && (!lastDate || regP.iso > lastDate)) lastDate = regP.iso;

    const raw: Record<string, string> = {};
    header.forEach((h, c) => { if (h) raw[h] = text(r[c]); });

    byKey.set(sourceKey, {
      sheetRow, fullNameRaw: fullName, ...parts, nameNorm, looseKey: looseKeyOf(parts),
      linkKey: linkKeyOf(nameNorm, dobP.iso), tokens: tokensOf(parts),
      phoneE164: phone.e164, phone10: p10, email, dob: dobP.iso,
      sex, address,
      referredByDoctor, referredByRaw,
      releaseMedium: release.id, releaseMediumRaw,
      seniorKind, seniorNumber: pairedSeniorNumber,
      registeredOn: regP.iso, sourceRaw: text(r[16]), sourceNorm: answer.norm, referralSourceId: answer.id,
      unmappedSource: answer.unmapped, newRepeat, raw, rowHash, sourceKey, dupCount: 1,
    });
  }
  return { rows: [...byKey.values()], rowsRead, lastDate, undated, issues };
}
