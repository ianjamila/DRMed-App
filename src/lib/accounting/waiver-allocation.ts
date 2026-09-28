// Mirror of the split waive_visit_balance() (migration 0183) makes when an
// admin waives a visit balance: the remainder is spread over the visit's
// priced live lines by the LARGEST-REMAINDER method in centavos, so the
// pieces add up exactly and no line carries more than its own price. The SQL
// is the source of truth (0183's smoke case H uses the same fixture); this
// feeds the waive dialog's preview and nothing else.
import { classifyKind } from "@/lib/visits/classification";

export interface WaiverLine {
  id: string;
  /** final_price_php as billed. */
  pricePhp: number;
  /** services.kind — doctor kinds go to 4920, everything else to 4910. */
  kind: string | null | undefined;
  /** parent_id != null: a ₱0 package component, never allocated to. */
  isComponent: boolean;
  status: string;
}

export interface WaiverAllocation {
  id: string;
  amountPhp: number;
  account: "4910" | "4920";
}

const toC = (php: number): number => Math.round(php * 100);
// Plain code-unit compare: for lowercase-hex uuids this is byte order, the same
// order Postgres gives `order by test_request_id` in the SQL (localeCompare is
// locale-dependent and only coincidentally agrees).
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function discountAccountFor(kind: string | null | undefined): "4910" | "4920" {
  const cls = classifyKind(kind ?? "");
  return cls === "consult" || cls === "procedure" ? "4920" : "4910";
}

/** The lines a waiver is spread over: priced, live, not a component, not cancelled. */
export function allocatableLines(lines: readonly WaiverLine[]): WaiverLine[] {
  return lines.filter((l) => !l.isComponent && l.status !== "cancelled" && toC(l.pricePhp) > 0);
}

export function allocateWaiver(remainderPhp: number, lines: readonly WaiverLine[]): WaiverAllocation[] {
  const rem = toC(remainderPhp);
  if (rem <= 0) return [];
  const pool = allocatableLines(lines);
  const sum = pool.reduce((s, l) => s + toC(l.pricePhp), 0);
  if (sum === 0) throw new Error("No priced lines to allocate the waiver over.");
  if (rem > sum) throw new Error("This visit's total is more than its lines add up to; fix the lines first.");
  // BigInt: centavos × centavos passes 2^53 around ₱9.5M × ₱9.5M, where a
  // double would round the quotient and the SQL (numeric) would not.
  const remB = BigInt(rem);
  const sumB = BigInt(sum);
  const shares = pool.map((l) => {
    const p = BigInt(toC(l.pricePhp));
    return {
      id: l.id,
      account: discountAccountFor(l.kind),
      share: Number((remB * p) / sumB),
      frac: (remB * p) % sumB,
    };
  });
  let left = rem - shares.reduce((s, x) => s + x.share, 0);
  const order = [...shares].sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : byId(a.id, b.id)));
  for (const x of order) {
    if (left === 0) break;
    x.share += 1;
    left -= 1;
  }
  return shares
    .filter((x) => x.share > 0)
    .sort((a, b) => byId(a.id, b.id))
    .map((x) => ({ id: x.id, amountPhp: x.share / 100, account: x.account }));
}

/**
 * What the waive dialog says: how much lands on each discount account.
 * `totalPhp` is the visit total; the RPC refuses unless it equals the priced
 * live lines EXACTLY (either direction — 0183 [CR-6]), so the preview mirrors
 * that check rather than only the "remainder bigger than the lines" half that
 * `allocateWaiver` can see on its own.
 */
export function waiverPreview(
  remainderPhp: number,
  lines: readonly WaiverLine[],
  totalPhp?: number,
): { labPhp: number; doctorPhp: number; lines: number } {
  if (totalPhp !== undefined) {
    const sum = allocatableLines(lines).reduce((s, l) => s + toC(l.pricePhp), 0);
    if (toC(totalPhp) !== sum) {
      throw new Error("This visit's total does not match its lines; fix the lines before waiving.");
    }
  }
  const out = allocateWaiver(remainderPhp, lines);
  const sum = (acct: "4910" | "4920") =>
    out.filter((o) => o.account === acct).reduce((s, o) => s + toC(o.amountPhp), 0) / 100;
  return { labPhp: sum("4910"), doctorPhp: sum("4920"), lines: out.length };
}
