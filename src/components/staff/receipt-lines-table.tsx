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
const CELL = "px-2 py-3 first:pl-0 last:pr-0 print:py-1.5";
const MONEY = `${CELL} whitespace-nowrap text-right tabular-nums`;

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
        {rows.map(({ line: l, includedInPackage, showAmounts }) => (
          <tr
            key={l.id}
            className={
              includedInPackage ? "text-[color:var(--color-brand-text-soft)]" : undefined
            }
          >
            <td className={`${CELL} font-mono [overflow-wrap:anywhere]`}>
              {breakableCode(l.svc?.code)}
            </td>
            <td className={`${CELL} ${includedInPackage ? "pl-5 print:pl-4" : ""}`}>
              {l.svc?.name}
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
                <td className={MONEY} />
                <td className={MONEY} />
                <td className={MONEY} />
              </>
            )}
          </tr>
        ))}
      </tbody>
      {/* A printed <tfoot> repeats at the foot of EVERY page, so a bill that
          runs onto a second sheet would show the grand total under a
          partial list. Print it as an ordinary row group: once, at the end.
          (<thead> keeps repeating — column headings on page 2 help.) */}
      <tfoot className="text-sm print:table-row-group">
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
