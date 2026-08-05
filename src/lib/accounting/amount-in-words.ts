/**
 * Peso amounts spelled out in words.
 *
 * Philippine acknowledgment receipts and cash vouchers print the amount twice —
 * in figures and in words — so a figure can't be altered after signing. The PF
 * payout acknowledgment slip follows that convention.
 *
 * Pure logic (no `server-only`, no DB) so it is unit-tested and usable from
 * both server components and client components.
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

// Short scale, as used in PH English. Index = how many 3-digit groups in.
const SCALES = ["", "thousand", "million", "billion", "trillion"];

// Largest amount we can spell with SCALES above (999 trillion + change).
const MAX_PESOS = 10 ** 15 - 1;

/** 0–999 in words. Callers guarantee the range. */
function chunkToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    return ones ? `${tens}-${ONES[ones]}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} ${chunkToWords(rest)}` : hundreds;
}

/**
 * A non-negative integer in words. Returns "zero" for 0.
 */
export function integerInWords(n: number): string {
  if (n === 0) return "zero";

  const groups: string[] = [];
  let remaining = n;
  let scale = 0;
  while (remaining > 0) {
    const chunk = remaining % 1000;
    if (chunk > 0) {
      const words = chunkToWords(chunk);
      groups.unshift(SCALES[scale] ? `${words} ${SCALES[scale]}` : words);
    }
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  return groups.join(" ");
}

/**
 * A peso amount spelled out, sentence-cased, ending in "only" — the wording
 * used on PH vouchers, e.g. "One thousand six hundred pesos only" or
 * "Two hundred pesos and fifty centavos only".
 *
 * Amounts are rounded to the centavo first, so 1234.567 reads as
 * "…thirty-four pesos and fifty-seven centavos only". A negative amount (a
 * clawback batch) is prefixed "Minus". Anything beyond the trillions falls
 * back to the plain figure rather than inventing a scale word.
 */
export function pesosInWords(amount: number | string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return "";

  const negative = value < 0;
  const totalCentavos = Math.round(Math.abs(value) * 100);
  const pesos = Math.floor(totalCentavos / 100);
  const centavos = totalCentavos % 100;

  if (pesos > MAX_PESOS) {
    return `${negative ? "Minus " : ""}${(totalCentavos / 100).toFixed(2)} pesos only`;
  }

  const pesoWords =
    pesos === 1 ? "one peso" : `${integerInWords(pesos)} pesos`;
  const centavoWords =
    centavos === 1 ? "one centavo" : `${integerInWords(centavos)} centavos`;

  // "Fifty centavos only" reads better than "Zero pesos and fifty centavos
  // only" when the batch is under a peso.
  let phrase: string;
  if (pesos === 0 && centavos > 0) {
    phrase = `${centavoWords} only`;
  } else if (centavos > 0) {
    phrase = `${pesoWords} and ${centavoWords} only`;
  } else {
    phrase = `${pesoWords} only`;
  }

  if (negative) phrase = `minus ${phrase}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
