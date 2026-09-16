import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { DisbursementDetailClient } from "./disbursement-detail-client";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
    .from("doctor_pf_disbursements")
    .select(
      `
      id, batch_number, posted_date, method, total_php, notes,
      voided_at, void_reason, journal_entry_id, recorded_at,
      physicians(id, full_name),
      recorded_by_staff:staff_profiles!recorded_by(id, full_name)
    `
    )
    .eq("id", id)
    .single();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/admin/accounting/pf-payouts/[id]"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.batch_number == null ? null : String(data.batch_number);
  });
}
export const dynamic = "force-dynamic";

export default async function PfDisbursementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: disb } = await loadDetail(id);

  if (!disb) notFound();

  const { data: entries } = await admin
    .from("doctor_pf_entries")
    .select("id, pf_php, test_request_id, recognition_basis, recognized_at")
    .eq("disbursement_id", id)
    .order("recognized_at", { ascending: true });

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <DisbursementDetailClient
        disbursement={disb}
        entries={entries ?? []}
      />
    </div>
  );
}
