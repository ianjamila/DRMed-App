import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientForm } from "../../patient-form";
import { listActiveReferralSources } from "@/lib/legacy-import/loaders";
import { Panel } from "@/components/ui/panel";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
      .from("patients")
      .select(
        "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, consent_signed_at",
      )
      .eq("id", id)
      .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/patients/[id]/edit"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.drm_id;
  });
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditPatientPage({ params }: Props) {
  await requireActiveStaff();
  const { id } = await params;

  const [{ data: patient }, sources] = await Promise.all([
    loadDetail(id),
    listActiveReferralSources(),
  ]);
  if (!patient) notFound();

  const referralOptions = [
    { value: "", label: "—" },
    ...sources.map((s) => ({ value: s.id, label: s.label })),
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {patient.last_name}, {patient.first_name}
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit patient
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        DRM-ID {patient.drm_id} · birthdate, identity & marketing fields.
      </p>
      <Panel className="mt-8 p-6">
        <PatientForm initial={patient} referralOptions={referralOptions} />
      </Panel>
    </div>
  );
}
