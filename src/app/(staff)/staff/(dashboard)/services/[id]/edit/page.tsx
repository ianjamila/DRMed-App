import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ServiceForm } from "../../service-form";

export const metadata = {
  title: "Edit service — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditServicePage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;
  const supabase = await createClient();
  const { data: service } = await supabase
    .from("services")
    .select(
      "id, code, name, description, price_php, turnaround_hours, is_active, requires_signoff",
    )
    .eq("id", id)
    .maybeSingle();

  if (!service) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/services"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Services
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit service
      </h1>
      <p className="mt-1 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
        {service.code}
      </p>
      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <ServiceForm initial={service} />
      </div>
    </div>
  );
}
