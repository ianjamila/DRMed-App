import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { DiscountTypeForm } from "../discount-type-form";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "New discount — staff" };

export default async function NewDiscountTypePage() {
  await requireAdminStaff();
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/discounts"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Discounts
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New discount
      </h1>
      <Panel className="mt-6 p-6">
        <DiscountTypeForm />
      </Panel>
    </div>
  );
}
