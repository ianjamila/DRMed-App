import { Fragment, type ReactNode } from "react";
import { formatPhp } from "@/lib/marketing/format";
import {
  arrangeReceiptRows,
  type PackageAwareReceiptLine,
} from "@/lib/visits/receipt-totals";

interface ReceiptLine extends PackageAwareReceiptLine {
  svc: { code: string; name: string } | undefined;
}

interface Props {
  lines: readonly ReceiptLine[];
  subtotal: number;
  totalDiscount: number;
  total: number;
  /** Printed after "Discount" in the totals, e.g. the Senior/PWD ID. */
  discountNote?: ReactNode;
}

/**
 * The line table + totals shared by the single-visit and the combined group
 * receipt, so a layout fix to one can't be forgotten on the other.
 *
 * Every cell carries horizontal padding: the money columns are right-aligned
 * and sized to their content, so without it adjacent headings run together
 * ("PRICEDISCOUNT") and so do "Total Due" and its amount.
 */
const PAD_X = "px-2 first:pl-0 last:pr-0";
const CELL = `${PAD_X} py-3 print:py-1.5`;
const MONEY_X = "whitespace-nowrap text-right tabular-nums";
const MONEY = `${CELL} ${MONEY_X}`;
// A package's included tests are a list, not charges: tighter rows so a
// full package still fits one A5 sheet with its totals.
const INCLUDED = `${PAD_X} py-1.5 print:py-0.5`;
const INCLUDED_MONEY = `${INCLUDED} ${MONEY_X}`;

// Service codes are single long tokens (EXECUTIVE_PACKAGE_STANDARD). Offer a
// line break after each underscore so the code column can wrap on A5 instead
// of forcing the table wider than the paper.
function breakableCode(code: string | undefined): ReactNode {
  if (!code) return null;
  const parts = code.split("_");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? (
        <>
          _<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

export function ReceiptLinesTable({
  lines,
  subtotal,
  totalDiscount,
  total,
  discountNote,
}: Props) {
  const rows = arrangeReceiptRows(lines);
  return (
    <table className="w-full text-sm print:text-xs">
      <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        <tr>
          <th className={CELL}>Code</th>
          <th className={CELL}>Service</th>
          <th className={`${CELL} text-right`}>Price</th>
          <th className={`${CELL} text-right`}>Discount</th>
          <th className={`${CELL} text-right`}>Net</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
        {rows.map(({ line: l, includedInPackage, showAmounts, includedCount }) => (
          <tr
            key={l.id}
            className={
              includedInPackage ? "text-[color:var(--color-brand-text-soft)]" : undefined
            }
          >
            <td
              className={`${includedInPackage ? INCLUDED : CELL} font-mono [overflow-wrap:anywhere]`}
            >
              {breakableCode(l.svc?.code)}
            </td>
            <td className={includedInPackage ? `${INCLUDED} pl-5 print:pl-4` : CELL}>
              {l.svc?.name}
              {includedCount > 0 ? (
                <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Includes {includedCount} {includedCount === 1 ? "test" : "tests"}:
                </span>
              ) : null}
            </td>
            {showAmounts ? (
              <>
                <td className={MONEY}>{formatPhp(l.base)}</td>
                <td className={MONEY}>
                  {l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}
                </td>
                <td className={MONEY}>{formatPhp(l.final)}</td>
              </>
            ) : (
              // Included in the package above: billed on the package line,
              // so no amounts of its own (not "₱0", which reads as a charge).
              <>
                <td className={INCLUDED_MONEY} />
                <td className={INCLUDED_MONEY} />
                <td className={INCLUDED_MONEY} />
              </>
            )}
          </tr>
        ))}
      </tbody>
      {/* Prints once, at the end — see the tfoot rule in globals.css. */}
      <tfoot className="text-sm">
        <tr>
          <td colSpan={4} className="pr-2 pt-4 text-right text-[color:var(--color-brand-text-soft)]">
            Subtotal
          </td>
          <td className="whitespace-nowrap pl-2 pt-4 text-right tabular-nums">
            {formatPhp(subtotal)}
          </td>
        </tr>
        {totalDiscount > 0 && (
          <tr>
            <td colSpan={4} className="pr-2 pt-1 text-right text-[color:var(--color-brand-text-soft)]">
              Discount
              {discountNote}
            </td>
            <td className="whitespace-nowrap pl-2 pt-1 text-right tabular-nums">
              − {formatPhp(totalDiscount)}
            </td>
          </tr>
        )}
        <tr className="border-t-2 border-[color:var(--color-brand-navy)]">
          <td colSpan={4} className="py-3 pr-2 text-right font-bold">
            Total Due
          </td>
          <td className="whitespace-nowrap py-3 pl-3 text-right font-heading text-xl font-extrabold tabular-nums">
            {formatPhp(total)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
