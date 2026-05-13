import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { HmoClaimsClient } from "./hmo-claims-client";

export const metadata = { title: "HMO claims — staff" };
export const dynamic = "force-dynamic";

export default async function HmoClaimsIndexPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const [summary, unbilled, stuck, aging] = await Promise.all([
    admin.from("v_hmo_provider_summary").select("*").order("provider_name"),
    admin
      .from("v_hmo_unbilled")
      .select("*")
      .order("days_since_release", { ascending: false }),
    admin
      .from("v_hmo_stuck")
      .select("*")
      .order("days_since_submission", { ascending: false }),
    admin.from("v_hmo_ar_aging").select("*"),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.3 · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          HMO claims
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Per-provider HMO accounts receivable with unbilled / stuck-claim
          detection. Drill into a provider to manage their claim batches.
        </p>
      </header>
      <HmoClaimsClient
        summary={summary.data ?? []}
        unbilled={unbilled.data ?? []}
        stuck={stuck.data ?? []}
        aging={aging.data ?? []}
      />
    </div>
  );
}
