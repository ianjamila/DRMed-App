/**
 * Map the legacy sheet's free-text referral source to one of the
 * referral_sources.id values seeded in migration 0055. Unmapped → 'other'.
 */
const REFERRAL_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*doctor\b|\bdoc\b|^dr\.?$/i,                               "doctor_referral"],
  [/customer\s*referral|friend|word.?of.?mouth|family|relative/i, "customer_referral"],
  [/facebook|^fb$/i,                                              "online_facebook"],
  [/instagram|^ig$/i,                                             "online_instagram"],
  [/tiktok|tik.?tok/i,                                            "online_tiktok"],
  [/website|web.?site/i,                                          "online_website"],
  [/google|search/i,                                              "online_google"],
  [/walk[\s-]?in/i,                                               "walk_in"],
  [/returning|repeat|previous|former/i,                           "returning_patient"],
  [/northridge|tenant|employee/i,                                 "tenant_employee_northridge"],
  [/gift\s*code|voucher/i,                                        "gift_code"],
];

export interface ReferralMapResult {
  id: string;                  // always set; falls back to 'other'
  unmapped_raw?: string;       // present when mapping fell through
}

export function mapReferralSource(raw: string | undefined | null): ReferralMapResult {
  const text = (raw ?? "").trim();
  if (!text) return { id: "other", unmapped_raw: "" };
  for (const [pattern, id] of REFERRAL_PATTERNS) {
    if (pattern.test(text)) return { id };
  }
  return { id: "other", unmapped_raw: text };
}

/**
 * Map sheet free-text result-release preference to the existing
 * preferred_release_medium CHECK values: 'physical', 'email', 'viber',
 * 'gcash', 'pickup'. Unmapped → null (no warning; pref is genuinely optional).
 */
const RELEASE_PATTERNS: Array<[RegExp, string]> = [
  [/physical|in.?person|hand|claim/i, "physical"],
  [/e.?mail/i,                        "email"],
  [/viber/i,                          "viber"],
  [/gcash|g\.cash/i,                  "gcash"],
  [/counter|pick.?up/i,               "pickup"],
];

export interface ReleaseMapResult {
  id: string | null;
  unmapped_raw?: string;
}

export function mapReleaseMedium(raw: string | undefined | null): ReleaseMapResult {
  const text = (raw ?? "").trim();
  if (!text) return { id: null };
  for (const [pattern, id] of RELEASE_PATTERNS) {
    if (pattern.test(text)) return { id };
  }
  return { id: null, unmapped_raw: text };
}

export function mapSeniorPwdKind(raw: string | undefined | null): "senior" | "pwd" | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^(senior|sc|senior\s*citizen)$/.test(text)) return "senior";
  if (/^pwd$/.test(text)) return "pwd";
  return null;
}

export function mapSex(raw: string | undefined | null): "male" | "female" | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "female" || text === "f") return "female";
  if (text === "male"   || text === "m") return "male";
  return null;
}

/**
 * Parse a Philippine-style date of birth. Accepts M/D/YYYY, MM/DD/YYYY,
 * YYYY-MM-DD, and YYYY/MM/DD. Returns ISO yyyy-mm-dd or null.
 */
export function parseBirthdate(raw: string | undefined | null): { iso: string | null; unparseable: boolean } {
  const text = (raw ?? "").trim();
  if (!text) return { iso: null, unparseable: false };

  // ISO first
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return { iso: toIsoDate(+y, +m, +d), unparseable: false };
  }

  // US-style M/D/YYYY (the sheet uses this).
  const us = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/.exec(text);
  if (us) {
    const [, m, d, y] = us;
    return { iso: toIsoDate(+y, +m, +d), unparseable: false };
  }

  return { iso: null, unparseable: true };
}

function toIsoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}
