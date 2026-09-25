import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { formatPhoneLocal } from "@/lib/format/phone";
import { ReissuePinButton } from "@/components/staff/reissue-pin-button";
import { VerifyIdentityButton } from "./verify-identity-button";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { getConsentHistory, getPatientConsentState } from "@/lib/consent/gate";
import { latestIsBookingOnly } from "@/lib/consent/history";
import { ConsentPanel } from "./consent/consent-panel";
import { ConsentHistory } from "./consent/consent-history";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { formatPatientName } from "@/lib/patients/format-name";
import { referralSourceLabel } from "@/lib/patients/referral-sources";
import {
  PRE_REGISTERED_LABEL_FULL,
  PRE_REGISTERED_BADGE_CLASS,
} from "@/lib/patients/labels";
import { Panel } from "@/components/ui/panel";
import { EmailStatementButton } from "@/components/staff/email-statement-button";
import { STATEMENT_ROLES, waivedAmount } from "@/lib/visits/statement";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import { linkPayments, paymentMethodLabel } from "@/lib/visits/payment-history";
import {
  PAYMENT_HISTORY_SELECT,
  loadLinkedPayments,
  visitOf,
  type LoadedPayment,
} from "@/lib/visits/payment-history-load";
import { PaymentArrivalNote, PaymentChangeEntry } from "@/components/staff/payment-change-note";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const supabase = await createClient();
  return supabase
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, birthdate_confirmed, sex, phone, email, address, pre_registered, created_at, referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, consent_signed_at, is_repeat_patient",
    )
    .eq("id", id)
    .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/patients/[id]"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.drm_id;
  });
}

interface Props {
  params: Promise<{ id: string }>;
}

const PAYMENT_STATUS_STYLE: Record<string, string> = {
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-slate-200 text-slate-800",
};

const RELEASE_LABEL: Record<string, string> = {
  physical: "Physical pickup",
  email: "Email",
  viber: "Viber",
  gcash: "GCash",
  pickup: "Pickup at counter",
};

export default async function PatientDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await requireActiveStaff();
  const isAdmin = session.role === "admin";
  const supabase = await createClient();

  const { data: patient } = await loadDetail(id);

  if (!patient) notFound();

  const [consent, consentHistory] = await Promise.all([
    getPatientConsentState(id),
    getConsentHistory(id),
  ]);
  const bookingOnlyConsent = latestIsBookingOnly(consentHistory);

  const { data: visits } = await supabase
    .from("visits")
    .select("id, visit_number, visit_date, payment_status, total_php, paid_php, is_sample")
    .eq("patient_id", id)
    // Queue-deleted visits (0125) live in the admin deleted-entries report,
    // not the patient's visit history.
    .is("deleted_at", null)
    .order("visit_date", { ascending: false });

  // Every payment across this patient's live visits, including the deleted,
  // edited and moved ones (0161). payments RLS is reception/admin only (0001),
  // so other roles would get an empty list — don't render the section at all.
  // Uncapped: the most any patient has on prod is 39 payments over 72 visits.
  const canSeePayments = session.role === "reception" || session.role === "admin";
  // Each visit's statement of account (print or email) — the same audience.
  const canUseStatement = STATEMENT_ROLES.has(session.role);
  const visitIds = (visits ?? []).map((v) => v.id);
  let payments: LoadedPayment[] = [];
  let linked: LoadedPayment[] = [];
  if (canSeePayments && visitIds.length > 0) {
    const { data } = await supabase
      .from("payments")
      .select(PAYMENT_HISTORY_SELECT)
      .in("visit_id", visitIds)
      .order("received_at", { ascending: false })
      .order("id", { ascending: true })
      .returns<LoadedPayment[]>();
    payments = data ?? [];
    linked = await loadLinkedPayments(supabase, payments);
  }
  const paymentLinks = linkPayments([...payments, ...linked]);
  const activePayments = payments.filter((p) => !p.voided_at);
  const changedPayments = payments
    .filter((p) => p.voided_at)
    .sort((a, b) => (b.voided_at ?? "").localeCompare(a.voided_at ?? "") || a.id.localeCompare(b.id));
  const collected = activePayments.reduce((sum, p) => sum + Math.round(Number(p.amount_php) * 100), 0) / 100;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/patients"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patients
      </Link>

      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
            {patient.drm_id}
          </p>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {formatPatientName(patient)}
          </h1>
          {patient.pre_registered ? (
            <div className="flex flex-wrap items-center gap-2">
              <p
                className={`mt-1 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${PRE_REGISTERED_BADGE_CLASS}`}
              >
                {PRE_REGISTERED_LABEL_FULL}
              </p>
              <VerifyIdentityButton patientId={patient.id} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/staff/patients/${patient.id}/edit`}
            className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Edit
          </Link>
          <ReissuePinButton patientId={patient.id} />
          <Link
            href={`/staff/visits/new?patient_id=${patient.id}`}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            + Start visit
          </Link>
        </div>
      </header>

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-3">
        <Field label="Birthdate" value={patient.birthdate ?? "—"} />
        <Field label="Sex" value={patient.sex ?? "—"} />
        <Field label="Phone" value={patient.phone ? formatPhoneLocal(patient.phone) : "—"} />
        <Field label="Email" value={patient.email ?? "—"} />
        <Field label="Address" value={patient.address ?? "—"} />
        <Field
          label="Registered"
          value={manilaDate(patient.created_at)}
        />
      </section>

      {(!patient.birthdate || !patient.birthdate_confirmed) && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          <span aria-hidden>⚠</span>
          <span>
            {patient.birthdate
              ? "DOB not yet confirmed at the counter."
              : "DOB missing — ask the patient on their next visit."}
          </span>
          <Link
            href={`/staff/patients/${patient.id}/edit`}
            className="underline decoration-dotted underline-offset-2"
          >
            Edit
          </Link>
        </div>
      )}

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-3">
        <Field
          label="Referral source"
          value={referralSourceLabel(patient.referral_source) ?? "—"}
        />
        <Field
          label="Referred by"
          value={patient.referred_by_doctor ?? "—"}
        />
        <Field
          label="Result release pref."
          value={
            patient.preferred_release_medium
              ? RELEASE_LABEL[patient.preferred_release_medium] ??
                patient.preferred_release_medium
              : "—"
          }
        />
        <Field
          label="Senior / PWD"
          value={
            patient.senior_pwd_id_kind
              ? `${patient.senior_pwd_id_kind === "senior" ? "Senior" : "PWD"}${
                  patient.senior_pwd_id_number
                    ? ` · ${patient.senior_pwd_id_number}`
                    : ""
                }`
              : "—"
          }
        />
        <Field
          label="Visit history"
          value={patient.is_repeat_patient ? "Returning patient" : "First-timer"}
        />
      </section>

      <div id="consent" className="mt-3 scroll-mt-24">
        <ConsentPanel
          patientId={id}
          patientName={[patient.last_name, patient.first_name].filter(Boolean).join(", ")}
          drmId={patient.drm_id}
          current={consent.current}
          signedAt={consent.signedAt}
          noticeVersion={consent.noticeVersion}
          bookingOnlyConsent={bookingOnlyConsent}
          isAdmin={isAdmin}
        />
        <ConsentHistory patientId={id} events={consentHistory} />
      </div>

      <section className="mt-8">
        <h2 className="font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Visits
        </h2>
        <Panel className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Visit #</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Paid</th>
                <th className="px-4 py-3">Status</th>
                {canUseStatement ? <th className="px-4 py-3">Statement</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(visits ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={canUseStatement ? 6 : 5}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No visits yet.
                  </td>
                </tr>
              ) : (
                (visits ?? []).map((v) => (
                  <tr
                    key={v.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 font-mono">
                      <Link
                        href={`/staff/visits/${v.id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {v.visit_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {manilaDate(v.visit_date)}
                    </td>
                    <td className="px-4 py-3">{formatPhp(v.total_php)}</td>
                    <td className="px-4 py-3">
                      {formatPhp(v.paid_php)}
                      {/* Waiving writes no payment, so Paid alone falls short
                          of Total; name the remainder (same rule as the
                          visit page and the statement). */}
                      {waivedAmount(v) > 0 ? (
                        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {formatPhp(waivedAmount(v))} waived
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          PAYMENT_STATUS_STYLE[v.payment_status] ?? ""
                        }`}
                      >
                        {paymentStatusLabel(v.payment_status)}
                      </span>
                    </td>
                    {canUseStatement ? (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                          <Link
                            href={`/staff/visits/${v.id}/statement`}
                            aria-label={`Statement of account for visit ${v.visit_number}`}
                            className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                          >
                            Open
                          </Link>
                          <EmailStatementButton
                            visitId={v.id}
                            patientId={patient.id}
                            patientEmail={patient.email}
                            isSample={v.is_sample}
                            size="compact"
                            accessibleName={`Email the statement for visit ${v.visit_number}`}
                          />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </section>

      {canSeePayments ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
              Payments
            </h2>
            <p className="text-sm text-[color:var(--color-brand-text-soft)]">
              {formatPhp(collected)} across {activePayments.length}{" "}
              {activePayments.length === 1 ? "payment" : "payments"}
            </p>
          </div>
          <Panel className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Received</th>
                  <th className="px-4 py-3">Visit #</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {activePayments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                    >
                      No payments on record.
                    </td>
                  </tr>
                ) : (
                  activePayments.map((p) => {
                    const v = visitOf(p);
                    return (
                      <tr key={p.id} className="hover:bg-[color:var(--color-brand-bg)]">
                        <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                          {manilaDateTime(p.received_at)}
                        </td>
                        <td className="px-4 py-3 font-mono">
                          {v ? (
                            <Link
                              href={`/staff/visits/${v.id}`}
                              className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                            >
                              {v.visitNumber}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          {formatPhp(p.amount_php)}
                          <PaymentArrivalNote p={p} links={paymentLinks} />
                        </td>
                        <td className="px-4 py-3">{paymentMethodLabel(p.method)}</td>
                        <td className="px-4 py-3 font-mono text-xs">{p.reference_number ?? "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </Panel>
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            To edit, move or delete a payment, open its visit.
          </p>

          {changedPayments.length > 0 ? (
            <details className="mt-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Deleted, edited &amp; moved payments ({changedPayments.length})
              </summary>
              <ul className="mt-2 space-y-2 text-xs">
                {changedPayments.map((p) => (
                  <PaymentChangeEntry key={p.id} p={p} links={paymentLinks} showVisit />
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm ${
          highlight
            ? "text-amber-700 font-semibold"
            : "text-[color:var(--color-brand-text-mid)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
