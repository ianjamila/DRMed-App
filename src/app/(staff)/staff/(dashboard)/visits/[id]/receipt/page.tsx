import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { hasRecentAudit } from "@/lib/server/action-helpers";
import { peekVisitPinFlash } from "@/lib/auth/visit-pin-flash";
import { formatPhp } from "@/lib/marketing/format";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { getPatientConsentState } from "@/lib/consent/gate";
import { formatPatientName } from "@/lib/patients/format-name";
import { shouldPrintReceipt } from "@/lib/visits/receipt-policy";
import { hasStatutoryDiscountLine } from "@/lib/pricing/statutory";
import { visibleReceiptLines, receiptTotals } from "@/lib/visits/receipt-totals";
import { NoReceiptNotice } from "@/components/staff/no-receipt-notice";
import { PrintButton } from "./print-button";
import { logReceiptPrintAction } from "./log-print-action";

export const metadata = {
  title: "Receipt — staff",
};
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Portal access without a bill.
 *
 * A consultation-only visit prints no receipt, so its Secure PIN never
 * reaches the patient at the counter. When reception deliberately issues one
 * from the visit page, this is what they hand over: the same portal block the
 * full receipt carries, on its own, with no service lines or totals.
 */
function PortalAccessSlip({
  visitId,
  patientName,
  drmId,
  plainPin,
}: {
  visitId: string;
  patientName: string;
  drmId: string;
  plainPin: string;
}) {
  return (
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visitId}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <PrintButton hasFlash onPrint={logReceiptPrintAction.bind(null, visitId)} />
      </div>

      <article className="receipt-sheet rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0 print:text-xs">
        <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4 print:pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
          <img src="/logo.png" alt="DRMed" className="mb-2 h-14 w-auto print:mb-1 print:h-10" />
          <p className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)] print:text-lg">
            {SITE.name}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
          </p>
          <p className="mt-2 inline-block rounded bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
            Patient portal access
          </p>
        </header>

        <div className="py-4 text-sm print:py-2">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Patient
          </p>
          <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
            {patientName}
          </p>
        </div>

        <div className="rounded-xl border-2 border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5 print:break-inside-avoid print:p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">DRM-ID</p>
              <p className="font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {drmId}
              </p>
            </div>
            <div>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">Secure PIN</p>
              <p className="font-mono text-lg font-extrabold tracking-widest text-[color:var(--color-brand-navy)]">
                {plainPin}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Sign in at{" "}
            <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong> to view
            results when ready. PIN is valid for 60 days and replaces any earlier
            one. Keep it private — anyone with this PIN can view the patient&apos;s
            lab results.
          </p>
        </div>

        <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)] print:mt-2">
          This slip is portal access only — it is not a receipt and shows no
          charges.
        </p>
      </article>
    </div>
  );
}

export default async function ReceiptPage({ params }: Props) {
  const { id } = await params;
  // A8: get the actor for the disclosure audit below. The dashboard layout
  // already gates on requireActiveStaff — this call is cheap (cookie-backed)
  // and mirrors the count-sheet / payslip pages, which re-derive the session
  // themselves rather than threading it through props.
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, total_php, visit_group_id,
        patients!inner (
          id, drm_id, first_name, middle_name, last_name,
          senior_pwd_id_kind, senior_pwd_id_number
        ),
        test_requests (
          id, deleted_at,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php, kind )
        )
      `,
    )
    .eq("id", id)
    // A deleted visit has no bill — nothing to print (0125).
    .is("deleted_at", null)
    .maybeSingle();

  if (!visit) notFound();
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();

  const consent = await getPatientConsentState(patient.id);

  // Statutory (Senior/PWD) codes from the admin-managed catalog — detection
  // reads this flag, not the `senior_pwd_20` literal, so a future
  // admin-created statutory discount is picked up automatically.
  const { data: statutoryDiscountRows, error: statutoryDiscountErr } =
    await supabase.from("discount_types").select("code").eq("is_statutory", true);
  if (statutoryDiscountErr) {
    // An empty set silently drops the Senior/PWD block from a printed
    // receipt, which is a statutory field — so never let the failure pass
    // unrecorded, even though staff RLS makes it unlikely.
    console.error(
      "receipt: statutory discount lookup failed",
      statutoryDiscountErr.message,
    );
  }
  const statutoryDiscountCodes = new Set(
    (statutoryDiscountRows ?? []).map((d) => d.code),
  );

  // N8: a soft-deleted test line (0125) must never reappear — or get
  // charged for — on a reprint. `lines` is the VISIBLE set used for every
  // render and total below; `allLines` only exists to preserve the deleted
  // count in the view audit's metadata.
  const allLines = (visit.test_requests ?? []).map((tr) => {
    const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
    const base = tr.base_price_php ?? svc?.price_php ?? 0;
    const discount = tr.discount_amount_php ?? 0;
    const final = tr.final_price_php ?? base - discount;
    return {
      id: tr.id,
      svc,
      base,
      discount,
      final,
      discountKind: tr.discount_kind,
      deleted: tr.deleted_at !== null,
    };
  });
  const lines = visibleReceiptLines(allLines);

  // Plain PIN — present only on the redirect from createVisit, or from a
  // deliberate re-issue. The cookie is read here (server component is
  // read-only) and cleared right after mount by ClearPinOnMount.
  const plainPin = await peekVisitPinFlash(visit.id);

  // A8: view of a receipt is itself a disclosure (name, DRM-ID, line items,
  // prices, and — while the flash cookie lives — the plaintext portal PIN).
  // Dedupe like `payroll_payslip.viewed`: `force-dynamic` re-renders on every
  // back-button nav, so suppress a repeat row from the same viewer within 5
  // minutes rather than flooding the log. Never include the PIN itself.
  async function logReceiptViewed(kind: "portal_access_slip" | "full") {
    const admin = createAdminClient();
    const recentlyViewed = await hasRecentAudit(
      admin,
      { actor_id: session.user_id, action: "receipt.viewed", resource_id: visit!.id },
      5,
    );
    if (recentlyViewed) return;
    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: patient!.id,
      action: "receipt.viewed",
      resource_type: "visit",
      resource_id: visit!.id,
      metadata: {
        visit_number: visit!.visit_number,
        kind,
        line_count: lines.length,
        deleted_line_count: allLines.length - lines.length,
        has_pin_flash: Boolean(plainPin),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  // Item 1 / decision 4: consultation-only visits print no bill. The button
  // that links here is hidden for them, but the URL is guessable and stale
  // links exist — explain rather than 404. The one exception is a freshly
  // re-issued PIN: reception asked for portal access on purpose, so print the
  // PIN on its own slip (no billing lines) rather than swallowing it.
  if (
    !shouldPrintReceipt(
      lines.map((l) => l.svc?.kind).filter((kind): kind is string => Boolean(kind)),
    )
  ) {
    if (plainPin) {
      await logReceiptViewed("portal_access_slip");
      return (
        <PortalAccessSlip
          visitId={visit.id}
          patientName={formatPatientName(patient)}
          drmId={patient.drm_id}
          plainPin={plainPin}
        />
      );
    }
    return (
      <NoReceiptNotice
        title={`No receipt for visit #${visit.visit_number}`}
        backHref={`/staff/visits/${visit.id}`}
        secondaryHref={
          visit.visit_group_id
            ? `/staff/visits/group/${visit.visit_group_id}/receipt`
            : undefined
        }
        secondaryLabel="Print the lab slip for this patient visit →"
      />
    );
  }

  const { subtotal, totalDiscount, total } = receiptTotals(lines);
  const hasSeniorPwdLine = hasStatutoryDiscountLine(lines, statutoryDiscountCodes);
  await logReceiptViewed("full");

  return (
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <div className="flex items-center gap-3">
          {visit.visit_group_id ? (
            <Link
              href={`/staff/visits/group/${visit.visit_group_id}/receipt`}
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Print combined receipt →
            </Link>
          ) : null}
          <PrintButton
            hasFlash={Boolean(plainPin)}
            onPrint={logReceiptPrintAction.bind(null, visit.id)}
          />
        </div>
      </div>

      <article className="receipt-sheet rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0 print:text-xs">
        <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4 print:pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
          <img src="/logo.png" alt="DRMed" className="mb-2 h-14 w-auto print:mb-1 print:h-10" />
          <p className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)] print:text-lg">
            {SITE.name}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {CONTACT.address.line1}, {CONTACT.address.line2},{" "}
            {CONTACT.address.city}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {CONTACT.phone.mobile} · {CONTACT.phone.landline} ·{" "}
            {CONTACT.email}
          </p>
        </header>

        <div className="grid gap-3 border-b border-[color:var(--color-brand-bg-mid)] py-4 text-sm sm:grid-cols-2 print:py-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Patient
            </p>
            <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
              {formatPatientName(patient)}
            </p>
            <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
              {patient.drm_id}
            </p>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Data privacy consent: {consent.current ? "on file" : "not on file"}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Date
            </p>
            <p className="mt-0.5 font-semibold">
              {new Date(visit.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
            </p>
          </div>
        </div>

        <table className="w-full text-sm print:text-xs">
          <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="py-3 print:py-1.5">Code</th>
              <th className="py-3 print:py-1.5">Service</th>
              <th className="py-3 text-right print:py-1.5">Price</th>
              <th className="py-3 text-right print:py-1.5">Discount</th>
              <th className="py-3 text-right print:py-1.5">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="py-3 font-mono print:py-1.5">{l.svc?.code}</td>
                <td className="py-3 print:py-1.5">{l.svc?.name}</td>
                <td className="py-3 text-right print:py-1.5">{formatPhp(l.base)}</td>
                <td className="py-3 text-right print:py-1.5">{l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}</td>
                <td className="py-3 text-right print:py-1.5">{formatPhp(l.final)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <tr>
              <td colSpan={4} className="pt-4 text-right text-[color:var(--color-brand-text-soft)]">
                Subtotal
              </td>
              <td className="pt-4 text-right">{formatPhp(subtotal)}</td>
            </tr>
            {totalDiscount > 0 && (
              <tr>
                <td colSpan={4} className="pt-1 text-right text-[color:var(--color-brand-text-soft)]">
                  Discount
                  {hasSeniorPwdLine && patient.senior_pwd_id_number && (
                    <span className="ml-2 text-xs">
                      (Senior/PWD ID: {patient.senior_pwd_id_number})
                    </span>
                  )}
                </td>
                <td className="pt-1 text-right">− {formatPhp(totalDiscount)}</td>
              </tr>
            )}
            <tr className="border-t-2 border-[color:var(--color-brand-navy)]">
              <td colSpan={4} className="py-3 text-right font-bold">
                Total Due
              </td>
              <td className="py-3 text-right font-heading text-xl font-extrabold">
                {formatPhp(total)}
              </td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-6 rounded-xl border-2 border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5 print:mt-3 print:break-inside-avoid print:p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Patient Portal Access
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                DRM-ID
              </p>
              <p className="font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {patient.drm_id}
              </p>
            </div>
            <div>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Secure PIN
              </p>
              {plainPin ? (
                <p className="font-mono text-lg font-extrabold tracking-widest text-[color:var(--color-brand-navy)]">
                  {plainPin}
                </p>
              ) : (
                <p className="text-sm text-[color:var(--color-brand-text-soft)]">
                  Already viewed — re-issue from admin if needed.
                </p>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Sign in at <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong>{" "}
            to view results when ready. PIN is valid for 60 days. Keep it
            private — anyone with this PIN can view the patient&apos;s lab
            results.
          </p>
        </div>
      </article>
    </div>
  );
}
