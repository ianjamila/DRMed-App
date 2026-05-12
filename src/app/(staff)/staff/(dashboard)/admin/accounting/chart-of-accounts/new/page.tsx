import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { AccountForm } from "../account-form";
import { createAccountAction } from "../actions";

export const metadata = { title: "New account — staff" };
export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: parents } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .order("code", { ascending: true });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.1 · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New account
        </h1>
      </header>
      <AccountForm
        mode="create"
        defaults={{
          code: "",
          name: "",
          type: "asset",
          parent_id: null,
          description: null,
          is_active: true,
        }}
        parents={parents ?? []}
        action={createAccountAction}
      />
    </div>
  );
}
