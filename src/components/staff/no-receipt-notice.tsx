import Link from "next/link";
import { CONSULT_ONLY_RECEIPT_NOTE } from "@/lib/visits/receipt-policy";

interface Props {
  /** e.g. "No receipt for visit #0042". */
  title: string;
  /** Where "Back to the visit" goes. */
  backHref: string;
  /** Optional second link — the sibling slip that DOES print, if any. */
  secondaryHref?: string;
  secondaryLabel?: string;
}

/**
 * Stand-in for a receipt the clinic asked us to stop printing (partner
 * revisions item 1 / decision 4). Both receipt routes render this instead of
 * a slip: the buttons that link to them are hidden for consultation-only
 * visits, but the URLs are guessable and stale links exist, so explain rather
 * than 404.
 */
export function NoReceiptNotice({
  title,
  backHref,
  secondaryHref,
  secondaryLabel,
}: Props) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={backHref}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Visit
      </Link>
      <div className="mt-3 rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h1 className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          {title}
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
          {CONSULT_ONLY_RECEIPT_NOTE}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href={backHref}
            className="inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Back to the visit
          </Link>
          {secondaryHref && secondaryLabel ? (
            <Link
              href={secondaryHref}
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
            >
              {secondaryLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
