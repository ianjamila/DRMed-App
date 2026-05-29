import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { peekVisitPinFlash } from "@/lib/auth/visit-pin-flash";
import { formatPhp } from "@/lib/marketing/format";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { getPatientConsentState } from "@/lib/consent/gate";
import { PrintButton } from "./print-button";

export const metadata = {
  title: "Receipt — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ReceiptPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, total_php,
        patients!inner (
          id, drm_id, first_name, last_name,
          senior_pwd_id_kind, senior_pwd_id_number
        ),
        test_requests (
          id,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php )
        )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!visit) notFound();
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();

  const consent = await getPatientConsentState(patient.id);

  const lines = (visit.test_requests ?? []).map((tr) => {
    const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
    const base = tr.base_price_php ?? svc?.price_php ?? 0;
    const discount = tr.discount_amount_php ?? 0;
    const final = tr.final_price_php ?? base - discount;
    return { id: tr.id, svc, base, discount, final, discountKind: tr.discount_kind };
  });

  const subtotal = lines.reduce((s, l) => s + Number(l.base), 0);
  const totalDiscount = lines.reduce((s, l) => s + Number(l.discount), 0);
  const total = lines.reduce((s, l) => s + Number(l.final), 0);
  const hasSeniorPwdLine = lines.some((l) => l.discountKind === "senior_pwd_20");

  // Plain PIN — present only on the redirect from createVisit. The cookie
  // is read here (server component is read-only) and cleared right after
  // mount by ClearPinOnMount.
  const plainPin = await peekVisitPinFlash(visit.id);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <PrintButton hasFlash={Boolean(plainPin)} />
      </div>

      <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0">
        <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4">
          <p className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
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

        <div className="grid gap-3 border-b border-[color:var(--color-brand-bg-mid)] py-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Patient
            </p>
            <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
              {patient.last_name}, {patient.first_name}
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
              Visit
            </p>
            <p className="mt-0.5 font-semibold">#{visit.visit_number}</p>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              {new Date(visit.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
            </p>
          </div>
        </div>

        <table className="w-full text-sm">
          <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="py-3">Code</th>
              <th className="py-3">Service</th>
              <th className="py-3 text-right">Price</th>
              <th className="py-3 text-right">Discount</th>
              <th className="py-3 text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="py-3 font-mono">{l.svc?.code}</td>
                <td className="py-3">{l.svc?.name}</td>
                <td className="py-3 text-right">{formatPhp(l.base)}</td>
                <td className="py-3 text-right">{l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}</td>
                <td className="py-3 text-right">{formatPhp(l.final)}</td>
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
              <td className="py-3 text-right font-[family-name:var(--font-heading)] text-xl font-extrabold">
                {formatPhp(total)}
              </td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-6 rounded-xl border-2 border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5">
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

        <p className="mt-6 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Thank you. Your results will be sent by SMS / email when ready.
        </p>
      </article>
    </div>
  );
}
