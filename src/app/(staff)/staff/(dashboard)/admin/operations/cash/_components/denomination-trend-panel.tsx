import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DenominationTrend } from "@/lib/accounting/denomination-trends";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

/**
 * Cash-count trends over the selected range.
 *
 * The wording here is load-bearing. The app cannot know which pile was actually
 * miscounted — payments record an amount, not the notes handed over, so there
 * is no expected-per-denomination figure to compare a count against. Every
 * attribution is arithmetic ("the difference divides evenly by ₱1,000"), and
 * the copy says so. Do not tighten these labels into claims of fact.
 */
export function DenominationTrendPanel({ trend }: { trend: DenominationTrend }) {
  const offDays = trend.shortDays + trend.overDays;
  const composition = trend.composition.filter((c) => c.daysPresent > 0);

  return (
    <Card className="mt-6 py-0">
      <details>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Cash count trends
        </summary>
        <div className="border-t px-3 py-3">
          {trend.closedDays === 0 ? (
            <EmptyState
              title="No end-of-day closes recorded in this period"
              description="Close shifts in Cash drawer → EOD to populate."
            />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Days closed</dt>
                  <dd className="font-mono text-base tabular-nums">{trend.closedDays}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Counted exactly</dt>
                  <dd className="font-mono text-base tabular-nums">{trend.balancedDays}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Short / over</dt>
                  <dd className="font-mono text-base tabular-nums">
                    {trend.shortDays} / {trend.overDays}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Net difference</dt>
                  <dd
                    className={cn(
                      "font-mono text-base tabular-nums",
                      trend.netVariancePhp < 0 && "text-destructive",
                    )}
                  >
                    {PESO(trend.netVariancePhp)}
                  </dd>
                </div>
              </dl>

              {trend.countedDays < trend.closedDays && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {trend.closedDays - trend.countedDays} of these days were closed before the
                  count sheet existed, so they add to the differences below but not to the till
                  make-up.
                </p>
              )}

              {offDays > 0 && (
                <section className="mt-4">
                  <h3 className="text-xs font-semibold text-[color:var(--color-brand-navy)]">
                    What the differences could be
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Grouped by the biggest note or coin that divides the difference exactly. A day
                    off by ₱1,000 is <em>consistent with</em>{" "}
                    one ₱1,000 note out of place — this is arithmetic, not proof. The system
                    doesn&rsquo;t record which notes came in over the counter, so it can&rsquo;t
                    know which pile was really miscounted.
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <Table className="text-xs">
                      <TableHeader>
                        <TableRow className="bg-muted/60 hover:bg-muted/60">
                          <TableHead className="px-3 py-2 text-left font-medium text-foreground">
                            Fits a difference of
                          </TableHead>
                          <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                            Days
                          </TableHead>
                          <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                            Net
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trend.buckets.map((b) => (
                          <TableRow key={b.label}>
                            <TableCell className="px-3 py-1">{b.label}</TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {b.days}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "px-3 py-1 text-right font-mono tabular-nums",
                                b.netPhp < 0 && "text-destructive",
                              )}
                            >
                              {PESO(b.netPhp)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}

              {composition.length > 0 && (
                <section className="mt-5">
                  <h3 className="text-xs font-semibold text-[color:var(--color-brand-navy)]">
                    What the till usually holds
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Average pieces on the days each one was counted.
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <Table className="text-xs">
                      <TableHeader>
                        <TableRow className="bg-muted/60 hover:bg-muted/60">
                          <TableHead className="px-3 py-2 text-left font-medium text-foreground">
                            Note / coin
                          </TableHead>
                          <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                            Days counted
                          </TableHead>
                          <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                            Average pieces
                          </TableHead>
                          <TableHead className="px-3 py-2 text-right font-medium text-foreground">
                            Total pieces
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {composition.map((c) => (
                          <TableRow key={c.key}>
                            <TableCell className="px-3 py-1">{c.label}</TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {c.daysPresent}
                            </TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {c.avgPieces}
                            </TableCell>
                            <TableCell className="px-3 py-1 text-right font-mono tabular-nums">
                              {c.totalPieces}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}
