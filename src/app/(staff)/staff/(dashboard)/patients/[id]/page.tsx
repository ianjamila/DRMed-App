import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { ReissuePinButton } from "./reissue-pin-button";

export const metadata = {
  title: "Patient — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

const PAYMENT_STATUS_STYLE: Record<string, string> = {
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-slate-200 text-slate-800",
};

const REFERRAL_LABEL: Record<string, string> = {
  doctor_referral: "Doctor referral",
  customer_referral: "Customer referral",
  online_facebook: "Facebook",
  online_website: "Website",
  online_google: "Google",
  walk_in: "Walk-in",
  tenant_employee_northridge: "Northridge tenant/employee",
  other: "Other",
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
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered, created_at, referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, consent_signed_at, is_repeat_patient",
    )
    .eq("id", id)
    .maybeSingle();

  if (!patient) notFound();

  const { data: visits } = await supabase
    .from("visits")
    .select("id, visit_number, visit_date, payment_status, total_php, paid_php")
    .eq("patient_id", id)
    .order("visit_date", { ascending: false });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
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
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
            {patient.middle_name ? ` ${patient.middle_name}` : ""}
          </h1>
          {patient.pre_registered ? (
            <p className="mt-1 inline-block rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
              Pre-registered — verify identity at counter
            </p>
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
        <Field label="Birthdate" value={patient.birthdate} />
        <Field label="Sex" value={patient.sex ?? "—"} />
        <Field label="Phone" value={patient.phone ?? "—"} />
        <Field label="Email" value={patient.email ?? "—"} />
        <Field label="Address" value={patient.address ?? "—"} />
        <Field
          label="Registered"
          value={new Date(patient.created_at).toLocaleDateString("en-PH")}
        />
      </section>

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-3">
        <Field
          label="Referral source"
          value={
            patient.referral_source
              ? REFERRAL_LABEL[patient.referral_source] ?? patient.referral_source
              : "—"
          }
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
          label="RA 10173 consent"
          value={
            patient.consent_signed_at
              ? `Signed ${new Date(patient.consent_signed_at).toLocaleDateString("en-PH")}`
              : "Not on file"
          }
          highlight={!patient.consent_signed_at}
        />
        <Field
          label="Visit history"
          value={patient.is_repeat_patient ? "Returning patient" : "First-timer"}
        />
      </section>

      <section className="mt-8">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Visits
        </h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Visit #</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Paid</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(visits ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
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
                      {new Date(v.visit_date).toLocaleDateString("en-PH")}
                    </td>
                    <td className="px-4 py-3">{formatPhp(v.total_php)}</td>
                    <td className="px-4 py-3">{formatPhp(v.paid_php)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          PAYMENT_STATUS_STYLE[v.payment_status] ?? ""
                        }`}
                      >
                        {v.payment_status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
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
