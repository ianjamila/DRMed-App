import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ItemForm } from "../item-form";

export const metadata = { title: "New inventory item — staff" };
export const dynamic = "force-dynamic";

export default async function NewInventoryItemPage() {
  await requireAdminStaff();
  const admin = createAdminClient();
  const { data: vendors } = await admin
    .from("vendors")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/inventory"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Inventory
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New inventory item
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Create the item definition first. After saving, record an initial
        receive movement so the balance reflects current stock.
      </p>

      <div className="mt-6">
        <ItemForm vendors={vendors ?? []} />
      </div>
    </div>
  );
}
