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

export default async function PatientDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered, created_at",
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

      <section className="mt-8">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Visits
        </h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full text-sm">
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-mid)]">
        {value}
      </p>
    </div>
  );
}
