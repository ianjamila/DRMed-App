import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { ConsentFormSheet } from "@/components/consent/consent-form-sheet";
import { PrintButton } from "@/components/consent/print-button";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
    .from("patients")
    .select("id, first_name, last_name, drm_id")
    .eq("id", id)
    .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/patients/[id]/consent/print"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : [data.last_name, data.first_name].filter(Boolean).join(", ");
  });
}
export const dynamic = "force-dynamic";

export default async function ConsentPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireActiveStaff();
  const { id } = await params;
  const { data: patient } = await loadDetail(id);
  if (!patient) notFound();

  // This page discloses the patient's name and DRM-ID (and, once printed, is
  // a physical artifact that can leave the building) — audit it like every
  // other print surface that shows patient data.
  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patient.id,
    action: "consent.form_printed",
    resource_type: "patient",
    resource_id: patient.id,
    ip_address: ip,
    user_agent: ua,
  });

  return (
    <div className="consent-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/patients/${patient.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Patient
        </Link>
        <PrintButton />
      </div>
      <ConsentFormSheet
        patient={{
          drm_id: patient.drm_id,
          first_name: patient.first_name,
          last_name: patient.last_name,
        }}
      />
    </div>
  );
}
