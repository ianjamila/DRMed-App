import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ItemForm } from "../../item-form";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const admin = createAdminClient();
  return admin
      .from("inventory_items")
      .select(
        "id, code, name, section, unit, reorder_threshold, expiry_tracking, vendor_id, notes, is_active",
      )
      .eq("id", id)
      .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/admin/inventory/[id]/edit"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.name;
  });
}
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditInventoryItemPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;

  const admin = createAdminClient();
  const [{ data: item }, { data: vendors }] = await Promise.all([
    loadDetail(id),
    admin.from("vendors").select("id, name").eq("is_active", true).order("name"),
  ]);

  if (!item) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/admin/inventory/${item.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {item.name}
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit inventory item
      </h1>

      <div className="mt-6">
        <ItemForm
          vendors={vendors ?? []}
          initial={{
            id: item.id,
            code: item.code,
            name: item.name,
            section: item.section,
            unit: item.unit,
            reorder_threshold: Number(item.reorder_threshold),
            expiry_tracking: item.expiry_tracking,
            vendor_id: item.vendor_id,
            notes: item.notes,
            is_active: item.is_active,
          }}
        />
      </div>
    </div>
  );
}
