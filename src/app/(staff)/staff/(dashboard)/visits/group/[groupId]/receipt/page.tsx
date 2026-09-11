import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { hasRecentAudit } from "@/lib/server/action-helpers";
import { peekVisitGroupPinFlash } from "@/lib/auth/visit-pin-flash";
import { formatPhp } from "@/lib/marketing/format";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { getPatientConsentState } from "@/lib/consent/gate";
import { formatPatientName } from "@/lib/patients/format-name";
import { shouldPrintReceipt } from "@/lib/visits/receipt-policy";
import { hasStatutoryDiscountLine } from "@/lib/pricing/statutory";
import { visibleReceiptLines, receiptTotals } from "@/lib/visits/receipt-totals";
import { NoReceiptNotice } from "@/components/staff/no-receipt-notice";
import { PrintButton } from "./print-button";
import { logGroupReceiptPrintAction } from "./log-print-action";

export const metadata = { title: "Combined receipt — staff" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ groupId: string }>;
}

const DOCTOR_KINDS = new Set(["doctor_consultation", "doctor_procedure"]);

export default async function GroupReceiptPage({ params }: Props) {
  const { groupId } = await params;
  // A8: get the actor for the disclosure audit below (mirrors the
  // single-visit receipt page).
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const { data: visits } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, total_php, visit_group_id,
        patients!inner (
          id, drm_id, first_name, middle_name, last_name,
          senior_pwd_id_kind, senior_pwd_id_number
        ),
        test_requests (
          id, deleted_at, base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php, kind )
        )
      `,
    )
    .eq("visit_group_id", groupId)
    .is("deleted_at", null)
    .order("visit_number", { ascending: true });

  if (!visits || visits.length === 0) notFound();
  const patient = Array.isArray(visits[0]!.patients)
    ? visits[0]!.patients[0]
    : visits[0]!.patients;
  if (!patient) notFound();

  const consent = await getPatientConsentState(patient.id);

  // Statutory (Senior/PWD) codes from the admin-managed catalog — fetched
  // once for the whole group, not per slip. Detection reads this flag, not
  // the `senior_pwd_20` literal, so a future admin-created statutory
  // discount is picked up automatically.
  const { data: statutoryDiscountRows, error: statutoryDiscountErr } =
    await supabase.from("discount_types").select("code").eq("is_statutory", true);
  if (statutoryDiscountErr) {
    // An empty set silently drops the Senior/PWD block from a printed
    // receipt, which is a statutory field — so never let the failure pass
    // unrecorded, even though staff RLS makes it unlikely.
    console.error(
      "group receipt: statutory discount lookup failed",
      statutoryDiscountErr.message,
    );
  }
  const statutoryDiscountCodes = new Set(
    (statutoryDiscountRows ?? []).map((d) => d.code),
  );

  // Order the slips: Doctor / PF first, then Lab & Services.
  //
  // Item 1 / decision 4: a slip whose every (live) line is a consultation is
  // dropped — that is the doctor slip the clinic asked us to stop printing.
  // The lab half of the same encounter still prints, and it carries the
  // portal PIN block below, so nothing is lost by suppressing this one.
  // N8: soft-deleted test lines (0125) never reach a slip's render or its
  // totals — `visibleReceiptLines` strips them before `lines` is stored on
  // the slip, so every downstream use (isDoctor classification, the
  // shouldPrintReceipt check, the render, the totals) sees only live lines.
  const slips = visits
    .map((v) => {
      const allLines = (v.test_requests ?? []).map((tr) => {
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
      const isDoctor = lines.some((l) => l.svc && DOCTOR_KINDS.has(l.svc.kind));
      const prints = shouldPrintReceipt(
        lines.map((l) => l.svc?.kind).filter((kind): kind is string => Boolean(kind)),
      );
      return { visit: v, lines, deletedLineCount: allLines.length - lines.length, isDoctor, prints };
    })
    .filter((slip) => slip.prints)
    .sort((a, b) => Number(b.isDoctor) - Number(a.isDoctor));

  // Every half suppressed — reachable when the lab half was deleted from the
  // queue and only the consultation survives. Say so instead of rendering a
  // slip-less page whose only content is the portal PIN.
  if (slips.length === 0) {
    return (
      <NoReceiptNotice
        title="No receipt for this patient visit"
        backHref={`/staff/visits/${visits[0]!.id}`}
      />
    );
  }

  const plainPin = await peekVisitGroupPinFlash(groupId);

  // A8: view of the combined receipt is a disclosure (name, DRM-ID, every
  // slip's line items and prices, and — while the flash cookie lives — the
  // plaintext portal PIN). Dedupe like the single-visit receipt: suppress a
  // repeat row from the same viewer within 5 minutes. Never include the PIN.
  const admin = createAdminClient();
  const recentlyViewed = await hasRecentAudit(
    admin,
    { actor_id: session.user_id, action: "receipt.viewed", resource_id: groupId },
    5,
  );
  if (!recentlyViewed) {
    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: patient.id,
      action: "receipt.viewed",
      resource_type: "visit_group",
      resource_id: groupId,
      metadata: {
        visit_ids: slips.map((s) => s.visit.id),
        slip_count: slips.length,
        deleted_line_count: slips.reduce((s, slip) => s + slip.deletedLineCount, 0),
        has_pin_flash: Boolean(plainPin),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  return (
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visits[0]!.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <PrintButton
          hasFlash={Boolean(plainPin)}
          onPrint={logGroupReceiptPrintAction.bind(null, groupId)}
        />
      </div>

      {slips.map((slip, idx) => {
        const { subtotal, totalDiscount, total } = receiptTotals(slip.lines);
        const hasSeniorPwdLine = hasStatutoryDiscountLine(slip.lines, statutoryDiscountCodes);
        return (
          <article
            key={slip.visit.id}
            className={`receipt-sheet rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0 print:text-xs ${
              idx > 0 ? "mt-8 print:mt-0 print:break-before-page" : ""
            }`}
          >
            <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4 print:pb-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
              <img src="/logo.png" alt="DRMed" className="mb-2 h-14 w-auto print:mb-1 print:h-10" />
              <p className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)] print:text-lg">
                {SITE.name}
              </p>
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                {CONTACT.address.line1}, {CONTACT.address.line2}, {CONTACT.address.city}
              </p>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
              </p>
              <p className="mt-2 inline-block rounded bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                {slip.isDoctor ? "Doctor / Professional Fee" : "Lab & Services"}
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
                  {new Date(slip.visit.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
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
                {slip.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="py-3 font-mono print:py-1.5">{l.svc?.code}</td>
                    <td className="py-3 print:py-1.5">{l.svc?.name}</td>
                    <td className="py-3 text-right print:py-1.5">{formatPhp(l.base)}</td>
                    <td className="py-3 text-right print:py-1.5">
                      {l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}
                    </td>
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
          </article>
        );
      })}

      <div className="mt-8 rounded-xl border-2 border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5 print:break-before-page">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Patient Portal Access
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">DRM-ID</p>
            <p className="font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              {patient.drm_id}
            </p>
          </div>
          <div>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">Secure PIN</p>
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
          Sign in at <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong> to view
          results when ready.{" "}
          {slips.length > 1 ? "One PIN covers both receipts. " : ""}Valid for 60
          days.
        </p>
      </div>
    </div>
  );
}
