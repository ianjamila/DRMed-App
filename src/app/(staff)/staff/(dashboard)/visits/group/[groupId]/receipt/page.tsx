import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { peekVisitGroupPinFlash } from "@/lib/auth/visit-pin-flash";
import { formatPhp } from "@/lib/marketing/format";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { getPatientConsentState } from "@/lib/consent/gate";
import { formatPatientName } from "@/lib/patients/format-name";
import { PrintButton } from "./print-button";
import { headers } from "next/headers";
import { ReceiptReviewCta } from "@/components/staff/receipt-review-cta";
import { reviewLinkAbsolute } from "@/lib/seo/review";

export const metadata = { title: "Combined receipt — staff" };

interface Props {
  params: Promise<{ groupId: string }>;
}

const DOCTOR_KINDS = new Set(["doctor_consultation", "doctor_procedure"]);

export default async function GroupReceiptPage({ params }: Props) {
  const { groupId } = await params;
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
          id, base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php, kind )
        )
      `,
    )
    .eq("visit_group_id", groupId)
    .order("visit_number", { ascending: true });

  if (!visits || visits.length === 0) notFound();
  const patient = Array.isArray(visits[0]!.patients)
    ? visits[0]!.patients[0]
    : visits[0]!.patients;
  if (!patient) notFound();

  const consent = await getPatientConsentState(patient.id);
  const plainPin = await peekVisitGroupPinFlash(groupId);

  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const reviewUrl = reviewLinkAbsolute(`${proto}://${host}`, "receipt");

  // Order the slips: Doctor / PF first, then Lab & Services.
  const slips = visits
    .map((v) => {
      const lines = (v.test_requests ?? []).map((tr) => {
        const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
        const base = tr.base_price_php ?? svc?.price_php ?? 0;
        const discount = tr.discount_amount_php ?? 0;
        const final = tr.final_price_php ?? base - discount;
        return { id: tr.id, svc, base, discount, final, discountKind: tr.discount_kind };
      });
      const isDoctor = lines.some((l) => l.svc && DOCTOR_KINDS.has(l.svc.kind));
      return { visit: v, lines, isDoctor };
    })
    .sort((a, b) => Number(b.isDoctor) - Number(a.isDoctor));

  return (
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visits[0]!.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <PrintButton hasFlash={Boolean(plainPin)} />
      </div>

      {slips.map((slip, idx) => {
        const subtotal = slip.lines.reduce((s, l) => s + Number(l.base), 0);
        const totalDiscount = slip.lines.reduce((s, l) => s + Number(l.discount), 0);
        const total = slip.lines.reduce((s, l) => s + Number(l.final), 0);
        const hasSeniorPwdLine = slip.lines.some((l) => l.discountKind === "senior_pwd_20");
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
          results when ready. One PIN covers both receipts. Valid for 60 days.
        </p>
      </div>

      <ReceiptReviewCta url={reviewUrl} />
    </div>
  );
}
