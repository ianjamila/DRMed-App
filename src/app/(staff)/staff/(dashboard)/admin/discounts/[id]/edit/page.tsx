import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { DiscountTypeForm } from "../../discount-type-form";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Edit discount — staff" };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditDiscountTypePage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: t } = await admin
    .from("discount_types")
    .select(
      "id, code, label, kind, percent, amount_php, is_statutory, active, sort_order",
    )
    .eq("id", id)
    .maybeSingle();
  if (!t) notFound();

  const initial = {
    ...t,
    kind: t.kind as "percent" | "fixed" | "custom",
    percent: t.percent != null ? Number(t.percent) : null,
    amount_php: t.amount_php != null ? Number(t.amount_php) : null,
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/discounts"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Discounts
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit discount
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {t.label}
      </p>
      <Panel className="mt-6 p-6">
        <DiscountTypeForm initial={initial} />
      </Panel>
    </div>
  );
}
