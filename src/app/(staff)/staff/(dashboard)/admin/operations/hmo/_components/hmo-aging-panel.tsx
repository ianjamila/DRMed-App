import { Card } from "@/components/ui/card";
import { AGING_BUCKETS, type AgingSummary } from "@/lib/operations/hmo-ar-report";

const peso = (n: number) =>
  `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function HmoAgingPanel({
  aging,
  labTotal,
  consultAr,
}: {
  aging: AgingSummary;
  labTotal: number;
  consultAr: number;
}) {
  // The roll-forward and the aging table measure AR on different bases, so their
  // grand totals won't match. Surface the gap explicitly rather than leave two
  // adjacent, conflicting "HMO AR" totals unexplained on a bookkeeper page.
  const rollForwardTotal = labTotal + consultAr;
  const agingBasisDelta = rollForwardTotal - aging.grandTotal;
  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-[#0b2a4a]">Current HMO AR by age</h2>
        <p className="text-xs text-muted-foreground">
          All outstanding HMO claims (lab + consult), bucketed by days since claim.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-[#0b2a4a] text-white">
            <tr>
              <th className="px-3 py-2 text-left">Provider</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} className="px-3 py-2 text-right">{b}</th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {aging.providers.map((p) => (
              <tr key={p.provider} className="border-t">
                <th className="px-3 py-2 text-left whitespace-nowrap">{p.provider}</th>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className="px-3 py-2 text-right tabular-nums">{peso(p.buckets[b])}</td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{peso(p.total)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-[#0b2a4a] font-semibold">
              <th className="px-3 py-2 text-left">TOTAL</th>
              {AGING_BUCKETS.map((b) => (
                <td key={b} className="px-3 py-2 text-right tabular-nums">{peso(aging.grandByBucket[b])}</td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums">{peso(aging.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Reconciliation: Lab AR (roll-forward) {peso(labTotal)} + Consult HMO AR {peso(consultAr)}{" "}
        = {peso(rollForwardTotal)}. The roll-forward above is lab-only; consult HMO AR is shown
        here for visibility (full consult roll-forward is a planned follow-on).
      </p>
      <p className="text-xs text-muted-foreground">
        Why this differs from the aging total {peso(aging.grandTotal)} above (by{" "}
        {peso(agingBasisDelta)}): the roll-forward counts <em>billed − dated-paid</em>, so claims
        marked paid but never given a settlement date stay in AR; the aging table counts only
        currently <em>pending / overdue</em> claims. Same receivables, two reporting bases — they
        are not expected to match exactly.
      </p>
    </Card>
  );
}
