import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientForm } from "../../patient-form";

export const metadata = { title: "Edit patient — staff" };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditPatientPage({ params }: Props) {
  await requireActiveStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: patient } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, consent_signed_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!patient) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {patient.last_name}, {patient.first_name}
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit patient
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        DRM-ID {patient.drm_id} · birthdate, identity & marketing fields.
      </p>
      <div className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <PatientForm initial={patient} />
      </div>
    </div>
  );
}
