/**
 * "How did you know about DR Med?" → referral_sources id (spec §4.1).
 * Order: (1) admin alias on the normalised answer, (2) ordered rules,
 * (3) blank → null ("Not recorded"), (4) anything else → "other" + unmapped
 * (the sync raises an unmapped_source review item). Rule order matters:
 * the more specific channel is listed before the one its words also match
 * ("WALK IN/ WOMEN'S UTZ" is a partner, "OLD PATIENT/WALK IN" is returning).
 */

import type { ReferralSourceId } from "../patients/referral-sources";

const TOKEN_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/^REF+ER+AL$/, "REFERRAL"],
  [/^(FAMIL|FAMILY|FAMLIY|DAMILY)$/, "FAMILY"],
  [/^(FRIENDS?|FRIENS|FIRIENDS|FRINEDS)$/, "FRIENDS"],
  [/^FACEBO+K$|^FACEBOK$/, "FACEBOOK"],
  [/^(DOCTO|DOCTORS|DOCTOR|DR|DOC)$/, "DOCTOR"],
  [/^CUSTOMERS?$/, "CUSTOMER"],
  [/^PX$/, "PATIENT"],
  [/^WOMENS?$/, "WOMEN"],
  [/^FLYER$/, "FLYERS"],
];

export function normalizeAnswer(raw: unknown): string {
  const text = String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/WALKIN/g, "WALK IN")
    .replace(/PHONECALL/g, "PHONE CALL")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!text) return "";
  return text
    .split(" ")
    .filter((t) => t !== "S")
    .map((t) => {
      for (const [re, to] of TOKEN_FOLDS) if (re.test(t)) return to;
      return t;
    })
    .join(" ");
}

const RULES: ReadonlyArray<[ReferralSourceId, RegExp]> = [
  ["prefer_not_to_say", /\bPREFER NOT\b/],
  ["walk_in_signage", /\bWALK IN\b.*\b(POSTER|SIGNAGE|SIGN)\b/],
  ["returning_patient", /\b(RETURNING|OLD|REGULAR|REPEAT) PATIENT\b/],
  ["tenant_employee_northridge", /\bNORTHRIDGE\b/],
  ["partner_corporate", /\b(WOMEN|LIKHAAN|SAFEMOMS|GICA)\b/],
  ["family_friends", /\b(FAMILY|FRIENDS)\b/],
  ["customer_referral", /\bCUSTOMER REFERRAL\b/],
  ["doctor_referral", /\bDOCTOR REFERRAL\b/],
  ["online_facebook", /\b(FACEBOOK|FB|MESSENGER)\b/],
  ["online_google", /\bGOOGLE\b/],
  ["online_website", /\bWEBSITE\b/],
  ["online_instagram", /\b(INSTAGRAM|IG)\b/],
  ["online_tiktok", /\bTIK ?TOK\b/],
  ["phone_text_viber", /\b(PHONE|CALL|TEXT|VIBER|SMS)\b/],
  ["flyers", /\bFLYERS\b/],
  ["gift_code", /\b(GIFT CODE|VOUCHER)\b/],
  ["walk_in", /\bWALK IN\b/],
];

export interface MappedAnswer {
  id: ReferralSourceId | null;
  norm: string;
  unmapped: boolean;
}

export function mapAnswer(raw: unknown, aliases: ReadonlyMap<string, string>): MappedAnswer {
  const norm = normalizeAnswer(raw);
  if (!norm) return { id: null, norm, unmapped: false };
  const alias = aliases.get(norm);
  // Alias values are the referral_source_id an admin picked via
  // sheet_alias_apply, FK-constrained to referral_sources — always a real id.
  if (alias) return { id: alias as ReferralSourceId, norm, unmapped: false };
  for (const [id, re] of RULES) if (re.test(norm)) return { id, norm, unmapped: false };
  return { id: "other", norm, unmapped: true };
}
