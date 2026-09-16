import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { HmoProviderForm } from "../../hmo-provider-form";
import { Panel } from "@/components/ui/panel";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
    .from("hmo_providers")
    .select(
      "id, name, is_active, due_days_for_invoice, unbilled_threshold_days, contract_start_date, contract_end_date, contact_person_name, contact_person_address, contact_person_phone, contact_person_email, notes",
    )
    .eq("id", id)
    .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/admin/hmo-providers/[id]/edit"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.name;
  });
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditHmoProviderPage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;

  const { data: p } = await loadDetail(id);
  if (!p) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/hmo-providers"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← HMO providers
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit HMO provider
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {p.name}
      </p>
      <Panel className="mt-6 p-6">
        <HmoProviderForm initial={p} />
      </Panel>
    </div>
  );
}
