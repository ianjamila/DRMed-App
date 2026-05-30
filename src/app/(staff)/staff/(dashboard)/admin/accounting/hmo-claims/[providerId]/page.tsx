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

  // Pre-fetch provider name for case-insensitive joins to historic_hmo_claims.
  const { data: providerForName } = await admin
    .from("hmo_providers")
    .select("name")
    .eq("id", providerId)
    .maybeSingle();
  const providerName = providerForName?.name ?? null;

  const [providerQ, summaryQ, batchesQ, unbilledQ, agingQ, staffQ, billedQ, paidQ, writtenOffQ, paymentMethodsQ] = await Promise.all([
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
    admin
      .from("staff_profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name"),
    providerName
      ? admin
          .from("historic_hmo_claims" as never)
          .select("id, patient_name, claim_date, service_description, base_amount_php, final_amount_php, status, date_submitted, deadline_date, billed_by_staff_id, source_tab, source_row")
          .ilike("hmo_provider", providerName)
          .in("status", ["pending", "overdue"])
          .not("date_submitted", "is", null)
          .order("claim_date", { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
    providerName
      ? admin
          .from("historic_hmo_claims" as never)
          .select("id, patient_name, claim_date, service_description, base_amount_php, final_amount_php, date_paid, or_number, paid_payment_method, journal_entry_id, source_tab, source_row")
          .ilike("hmo_provider", providerName)
          .eq("status", "paid")
          .order("date_paid", { ascending: false, nullsFirst: false })
          .limit(2000)
      : Promise.resolve({ data: [] as unknown[] }),
    providerName
      ? admin
          .from("historic_hmo_claims" as never)
          .select("id, patient_name, claim_date, service_description, final_amount_php, wrote_off_at, write_off_reason, wrote_off_journal_entry_id, source_tab, source_row")
          .ilike("hmo_provider", providerName)
          .eq("status", "written_off")
          .order("wrote_off_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
    admin
      .from("chart_of_accounts")
      .select("code, name")
      .eq("is_active", true)
      .eq("is_settlement_destination", true)
      .order("code"),
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
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
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
        staff={staffQ.data ?? []}
        paymentMethods={paymentMethodsQ.data ?? []}
        billed={(billedQ.data ?? []) as never}
        paid={(paidQ.data ?? []) as never}
        writtenOff={(writtenOffQ.data ?? []) as never}
      />
    </div>
  );
}
