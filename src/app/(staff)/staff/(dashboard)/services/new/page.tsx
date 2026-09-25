import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ServiceForm, type VendorLite } from "../service-form";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "New service",
};

export default async function NewServicePage() {
  await requireAdminStaff();

  // The send-out lab picker needs the same active-vendor list the edit page
  // loads. Without it the list was empty and the create action (which
  // requires a vendor for a send-out service) could never succeed.
  const { data: vendors } = await createAdminClient()
    .from("vendors")
    .select("id, name")
    .eq("is_active", true)
    .order("name");
  const vendorList: VendorLite[] = (vendors ?? []).map((v) => ({ id: v.id, name: v.name }));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/services"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Services
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New service
      </h1>
      <Panel className="mt-6 p-6">
        <ServiceForm vendors={vendorList} />
      </Panel>
    </div>
  );
}
