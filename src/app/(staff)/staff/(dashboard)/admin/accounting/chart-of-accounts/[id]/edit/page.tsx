import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { AccountForm } from "../../account-form";
import { updateAccountAction } from "../../actions";

export const metadata = { title: "Edit account — staff" };
export const dynamic = "force-dynamic";

export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: account } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type, parent_id, description, is_active")
    .eq("id", id)
    .maybeSingle();
  if (!account) notFound();

  const { data: parents } = await admin
    .from("chart_of_accounts")
    .select("id, code, name, type")
    .eq("is_active", true)
    .neq("id", id)
    .order("code", { ascending: true });

  // updateAccountAction needs the id; bind it.
  const boundAction = updateAccountAction.bind(null, id);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.1 · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Edit account
        </h1>
        <p className="mt-1 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {account.code} · {account.name}
        </p>
      </header>
      <AccountForm
        mode="edit"
        defaults={account}
        parents={parents ?? []}
        action={boundAction}
      />
    </div>
  );
}
