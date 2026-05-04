import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { HmoProviderForm } from "../../hmo-provider-form";

export const metadata = { title: "Edit HMO provider — staff" };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditHmoProviderPage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: p } = await admin
    .from("hmo_providers")
    .select(
      "id, name, is_active, due_days_for_invoice, contract_start_date, contract_end_date, contact_person_name, contact_person_address, contact_person_phone, contact_person_email, notes",
    )
    .eq("id", id)
    .maybeSingle();
  if (!p) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/hmo-providers"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← HMO providers
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit HMO provider
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {p.name}
      </p>
      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <HmoProviderForm initial={p} />
      </div>
    </div>
  );
}
