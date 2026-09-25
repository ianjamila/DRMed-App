import Link from "next/link";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDateTime } from "@/lib/dates/manila";
import { DELETE_CATEGORY_LABEL, paymentMethodLabel, type PaymentLinks } from "@/lib/visits/payment-history";
import { visitOf, voidedByName, type LoadedPayment } from "@/lib/visits/payment-history-load";

const LINK = "font-semibold text-[color:var(--color-brand-cyan)] hover:underline";

/**
 * Under an ACTIVE payment: how it came to be here, when it replaced another
 * (0161). Renders nothing for an ordinary payment.
 */
export function PaymentArrivalNote({
  p,
  links,
}: {
  p: LoadedPayment;
  links: PaymentLinks<LoadedPayment>;
}) {
  const how = links.arrivedBy(p);
  if (!how) return null;
  const orig = links.originalOf(p);
  if (how === "moved") {
    const from = orig ? visitOf(orig) : null;
    return (
      <span className="mt-0.5 block text-xs font-normal text-[color:var(--color-brand-text-soft)]">
        Moved from{" "}
        {from ? (
          <Link href={`/staff/visits/${from.id}`} className={LINK}>
            visit #{from.visitNumber}
          </Link>
        ) : (
          "another visit"
        )}
      </span>
    );
  }
  return (
    <span className="mt-0.5 block text-xs font-normal text-[color:var(--color-brand-text-soft)]">
      Edited
      {orig ? ` · was ${formatPhp(orig.amount_php)} ${paymentMethodLabel(orig.method)}` : null}
    </span>
  );
}

/**
 * One line of a payment's after-life, for a VOIDED payment: deleted, edited
 * (replaced by …) or moved (to visit #…), with who, when and why — plus how
 * it arrived, when it was itself a correction.
 */
export function PaymentChangeEntry({
  p,
  links,
  showVisit = false,
}: {
  p: LoadedPayment;
  links: PaymentLinks<LoadedPayment>;
  /** Patient page: name the visit the payment was on. */
  showVisit?: boolean;
}) {
  const fate = links.fate(p);
  const rep = links.replacementOf(p);
  const repVisit = rep ? visitOf(rep) : null;
  const here = visitOf(p);
  const by = voidedByName(p);
  const reason = links.reason(p);
  const category = links.deleteCategory(p);
  const why = [category ? DELETE_CATEGORY_LABEL[category] : null, reason].filter(Boolean).join(" — ");
  const verb = fate === "edited" ? "edited" : fate === "moved" ? "moved" : "deleted";
  return (
    <li className="rounded-md bg-white px-3 py-2">
      <div className="font-semibold text-[color:var(--color-brand-text-mid)]">
        {formatPhp(p.amount_php)} · {paymentMethodLabel(p.method)}
        {showVisit && here ? (
          <>
            {" "}
            · visit{" "}
            <Link href={`/staff/visits/${here.id}`} className={LINK}>
              #{here.visitNumber}
            </Link>
          </>
        ) : null}
        <span className="ml-2 font-normal text-[color:var(--color-brand-text-soft)]">
          {verb} {p.voided_at ? manilaDateTime(p.voided_at) : ""}
          {by ? ` by ${by}` : ""}
        </span>
      </div>
      {/* A payment that was itself moved in / an edit's replacement keeps saying
          so after it is changed again, or the chain breaks on this visit. */}
      <PaymentArrivalNote p={p} links={links} />
      {fate === "edited" && rep ? (
        <div className="mt-1 text-[color:var(--color-brand-text-mid)]">
          Replaced by {formatPhp(rep.amount_php)} {paymentMethodLabel(rep.method)}
          {rep.voided_at ? " (since changed again)" : ""}
        </div>
      ) : null}
      {fate === "moved" ? (
        <div className="mt-1 text-[color:var(--color-brand-text-mid)]">
          Moved to{" "}
          {repVisit ? (
            <>
              <Link href={`/staff/visits/${repVisit.id}`} className={LINK}>
                visit #{repVisit.visitNumber}
              </Link>
              {repVisit.patientName && repVisit.patientName !== here?.patientName
                ? ` · ${repVisit.patientName}`
                : ""}
            </>
          ) : (
            "another visit"
          )}
          {rep?.voided_at ? " (since changed again)" : ""}
        </div>
      ) : null}
      {why ? (
        <div className="mt-1 text-[color:var(--color-brand-text-soft)]">Reason: {why}</div>
      ) : null}
    </li>
  );
}
