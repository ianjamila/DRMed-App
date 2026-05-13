import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { BatchDetailClient } from "./batch-detail-client";

export const metadata = { title: "HMO claim batch — staff" };
export const dynamic = "force-dynamic";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: batch } = await admin
    .from("hmo_claim_batches")
    .select("*, hmo_providers(name)")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) notFound();

  const [itemsQ, resolutionsQ, allocationsQ] = await Promise.all([
    admin
      .from("hmo_claim_items")
      .select(
        "*, test_requests(id, service_id, visit_id, services(name, kind), visits(patients(drm_id, first_name, last_name)))",
      )
      .eq("batch_id", batchId)
      .order("created_at"),
    admin
      .from("hmo_claim_resolutions")
      .select("*, hmo_claim_items!inner(batch_id)")
      .eq("hmo_claim_items.batch_id", batchId)
      .order("resolved_at", { ascending: false }),
    admin
      .from("hmo_payment_allocations")
      .select(
        "*, hmo_claim_items!inner(batch_id), payments(reference_number, received_at)",
      )
      .eq("hmo_claim_items.batch_id", batchId)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <BatchDetailClient
        batch={batch}
        items={itemsQ.data ?? []}
        resolutions={resolutionsQ.data ?? []}
        allocations={allocationsQ.data ?? []}
      />
    </div>
  );
}
