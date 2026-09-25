// Patient Receivables (Aging): which visits make the table, and the
// "Completed work" count each row carries. Pure — the page loads the visits
// and the per-visit completed-work counts, this decides the row set so it
// can be tested without the page (RSC + DB).

import { NO_RELEASED, releasedTotal, type ReleasedCounts } from "@/lib/visits/payment-edit";

/** What the page has per visit before deciding the rows; extra fields pass through. */
export interface ArCandidate {
  v: { id: string; hmo_provider_id: string | null };
  /** total_php − paid_php, as the page computed it. */
  outstanding: number;
}

export interface ArRowsInput<C extends ArCandidate> {
  candidates: readonly C[];
  /** From loadCompletedWorkCounts over the owing non-HMO visit ids. */
  completedByVisit: ReadonlyMap<string, ReleasedCounts>;
  /** The opt-in "Completed work" filter (`?released=1`). */
  completedOnly: boolean;
}

export interface ArRows<C extends ArCandidate> {
  /** Every visit that owes something (the unfiltered default). */
  owingAll: (C & { completed: number })[];
  /** What the table, cards and pager show: owingAll, or only the badged rows. */
  owing: (C & { completed: number })[];
  /** How many owing visits carry completed work — the chip's count. */
  completedCount: number;
}

/**
 * Only rows that actually owe something belong in the table (a visit marked
 * unpaid with nothing left to collect is noise, and on prod that was 4,147 of
 * 4,153 rows). A row's `completed` is its released results + done doctor
 * lines (completed work); an HMO visit is never badged — it releases unpaid
 * by design (0133) — so it reads 0 whatever it released. The filter narrows
 * the cards too, so cards, table and pager keep describing one set.
 */
export function buildArRows<C extends ArCandidate>(input: ArRowsInput<C>): ArRows<C> {
  const owingAll = input.candidates
    .filter((r) => r.outstanding > 0)
    .map((r) => ({
      ...r,
      completed:
        r.v.hmo_provider_id === null ? releasedTotal(input.completedByVisit.get(r.v.id) ?? NO_RELEASED) : 0,
    }));
  const completedCount = owingAll.filter((r) => r.completed > 0).length;
  const owing = input.completedOnly ? owingAll.filter((r) => r.completed > 0) : owingAll;
  return { owingAll, owing, completedCount };
}
