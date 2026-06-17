// PURE module — no `import "server-only"`. The single source of truth for
// duplicate scoring, shared by the admin report and the staff near-match
// warning. Unit-tested without a DB. SQL does blocking; this does scoring.

export interface CandidateFields {
  first_name: string;
  last_name: string;
  birthdate: string | null; // ISO date string or null
  email: string | null;
  phone_normalized: string | null; // last-10-digits, or null
  address: string | null;
  sex: string | null;
}

export type DupTier = "exact_dup" | "strong" | "probable" | "weak";

export type DupSignal =
  | "exact_email"
  | "same_birthdate"
  | "same_last_name"
  | "same_first_name"
  | "fuzzy_name"
  | "same_phone"
  | "same_address"
  | "same_sex";

export interface DupScore {
  score: number;
  signals: DupSignal[];
  tier: DupTier | null; // null = below the weak floor, not a candidate
}

export const DUP_FUZZY_NAME_THRESHOLD = 0.85;
export const DUP_WEAK_FLOOR = 25;
export const DUP_PROBABLE_FLOOR = 45;
export const DUP_STRONG_FLOOR = 70;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Sørensen–Dice coefficient on character bigrams — cheap, dependency-free,
// good enough for short person names. Returns 0..1.
// Strings are padded with a space on each side so word-boundary bigrams are
// captured (e.g. " j" and "z "), which improves sensitivity for one-letter
// transpositions in names like "Jonathan" vs "Jonathon".
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = (s: string) => {
    const padded = ` ${s} `;
    const m = new Map<string, number>();
    for (let i = 0; i < padded.length - 1; i++) {
      const g = padded.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(x);
  const mb = bigrams(y);
  let inter = 0;
  for (const [g, ca] of ma) {
    const cb = mb.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  const px = ` ${x} `;
  const py = ` ${y} `;
  return (2 * inter) / (px.length - 1 + (py.length - 1));
}

export function scorePair(a: CandidateFields, b: CandidateFields): DupScore {
  const signals: DupSignal[] = [];
  let score = 0;

  const emailA = norm(a.email);
  const emailB = norm(b.email);
  const exactEmail = !!emailA && emailA === emailB;
  const sameLast = !!norm(a.last_name) && norm(a.last_name) === norm(b.last_name);
  const sameFirst = !!norm(a.first_name) && norm(a.first_name) === norm(b.first_name);
  const sameBirth = !!a.birthdate && a.birthdate === b.birthdate;
  const fullA = `${norm(a.first_name)} ${norm(a.last_name)}`.trim();
  const fullB = `${norm(b.first_name)} ${norm(b.last_name)}`.trim();
  const fuzzyName =
    !(sameFirst && sameLast) && nameSimilarity(fullA, fullB) >= DUP_FUZZY_NAME_THRESHOLD;
  const samePhone =
    !!a.phone_normalized &&
    a.phone_normalized.length === 10 &&
    a.phone_normalized === b.phone_normalized;
  const sameAddress = !!norm(a.address) && norm(a.address) === norm(b.address);
  const sameSex = !!a.sex && a.sex === b.sex;

  if (exactEmail) { signals.push("exact_email"); score += 50; }
  if (sameBirth) { signals.push("same_birthdate"); score += 25; }
  if (sameLast) { signals.push("same_last_name"); score += 15; }
  if (sameFirst) { signals.push("same_first_name"); score += 15; }
  if (fuzzyName) { signals.push("fuzzy_name"); score += 10; }
  if (samePhone) { signals.push("same_phone"); score += sameLast ? 20 : 8; } // family-phone down-weight
  if (sameAddress) { signals.push("same_address"); score += 10; }
  if (sameSex) { signals.push("same_sex"); score += 3; }

  // exact_dup short-circuit: definitionally the same person.
  if (exactEmail && sameFirst && sameLast && sameBirth) {
    return { score, signals, tier: "exact_dup" };
  }

  // Corroboration guard: strong/probable require a NON-phone identity anchor,
  // so shared family phones (and shared sibling households) can never reach an
  // actionable tier on phone/address alone.
  const corroborated =
    exactEmail ||
    (sameBirth && sameLast) ||
    (sameFirst && sameLast) ||
    (fuzzyName && sameBirth);

  let tier: DupTier | null = null;
  if (score >= DUP_STRONG_FLOOR && corroborated) tier = "strong";
  else if (score >= DUP_PROBABLE_FLOOR && corroborated) tier = "probable";
  else if (score >= DUP_WEAK_FLOOR) tier = "weak";

  return { score, signals, tier };
}
