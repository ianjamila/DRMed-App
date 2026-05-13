import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ProviderDetailClient } from "./provider-detail-client";

export const metadata = { title: "HMO provider — staff" };
export const dynamic = "force-dynamic";

export default async function ProviderDetailPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;
  await requireAdminStaff();
  const admin = createAdminClient();

  const [providerQ, summaryQ, batchesQ, unbilledQ, agingQ] = await Promise.all([
    admin
      .from("hmo_providers")
      .select("*")
      .eq("id", providerId)
      .maybeSingle(),
    admin
      .from("v_hmo_provider_summary")
      .select("*")
      .eq("provider_id", providerId)
      .maybeSingle(),
    admin
      .from("hmo_claim_batches")
      .select(
        "id, status, reference_no, submitted_at, voided_at, created_at",
      )
      .eq("provider_id", providerId)
      .order("created_at", { ascending: false }),
    admin
      .from("v_hmo_unbilled")
      .select("*")
      .eq("provider_id", providerId)
      .order("days_since_release", { ascending: false }),
    admin
      .from("v_hmo_ar_aging")
      .select("*")
      .eq("provider_id", providerId),
  ]);

  if (!providerQ.data) notFound();
  const provider = providerQ.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link
          href="/staff/admin/accounting/hmo-claims"
          className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← All HMO providers
        </Link>
      </div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.3 · Provider
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {provider.name}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
            {provider.due_days_for_invoice != null
              ? `Due in ${provider.due_days_for_invoice}d`
              : "No due days set"}{" "}
            · Unbilled threshold {provider.unbilled_threshold_days}d
            {provider.contact_person_name
              ? ` · Contact: ${provider.contact_person_name}`
              : ""}
          </p>
        </div>
        <Link
          href={`/staff/admin/accounting/hmo-claims/batches/new?providerId=${providerId}`}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white"
        >
          New batch
        </Link>
      </header>
      <ProviderDetailClient
        providerId={providerId}
        summary={summaryQ.data ?? null}
        batches={batchesQ.data ?? []}
        unbilled={unbilledQ.data ?? []}
        aging={agingQ.data ?? []}
      />
    </div>
  );
}
