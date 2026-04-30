import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { StaffForm } from "../../staff-form";

export const metadata = {
  title: "Edit staff user — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditStaffUserPage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: profile }, { data: userResp }] = await Promise.all([
    admin
      .from("staff_profiles")
      .select("id, full_name, role, is_active")
      .eq("id", id)
      .maybeSingle(),
    admin.auth.admin.getUserById(id),
  ]);

  if (!profile) notFound();

  const role = profile.role as
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin";

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/users"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Staff users
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit staff user
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {userResp?.user?.email ?? "—"}
      </p>
      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <StaffForm
          initial={{
            id: profile.id,
            email: userResp?.user?.email ?? "",
            full_name: profile.full_name,
            role,
            is_active: profile.is_active,
          }}
        />
      </div>
    </div>
  );
}
