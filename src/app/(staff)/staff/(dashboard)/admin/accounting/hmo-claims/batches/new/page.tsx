import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { NewBatchClient } from "./new-batch-client";

export const metadata = { title: "New HMO claim batch — staff" };
export const dynamic = "force-dynamic";

export default async function NewBatchPage({
  searchParams,
}: {
  searchParams: Promise<{ providerId?: string; trIds?: string }>;
}) {
  const params = await searchParams;
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: providers } = await admin
    .from("hmo_providers")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  const initialProviderId = params.providerId ?? providers?.[0]?.id ?? null;
  if (!initialProviderId) redirect("/staff/admin/accounting/hmo-claims");

  const { data: unbilled } = await admin
    .from("v_hmo_unbilled")
    .select(
      "test_request_id, released_at, billed_amount_php, days_since_release, past_threshold",
    )
    .eq("provider_id", initialProviderId)
    .order("days_since_release", { ascending: false });

  const preselectedIds = (params.trIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Normalize rows for client — server view columns are nullable; the client
  // only renders rows with a known test_request_id and skips nulls otherwise.
  const rows = (unbilled ?? [])
    .filter((r) => Boolean(r.test_request_id) && Boolean(r.released_at))
    .map((r) => ({
      test_request_id: r.test_request_id as string,
      released_at: r.released_at as string,
      billed_amount_php: Number(r.billed_amount_php ?? 0),
      days_since_release: Number(r.days_since_release ?? 0),
      past_threshold: Boolean(r.past_threshold),
    }));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.3 · New batch
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New HMO claim batch
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Pick a provider and the unbilled items to include. Saving creates a
          draft batch you can submit afterwards.
        </p>
      </header>
      <NewBatchClient
        providers={providers ?? []}
        initialProviderId={initialProviderId}
        unbilled={rows}
        preselectedIds={preselectedIds}
      />
    </div>
  );
}
