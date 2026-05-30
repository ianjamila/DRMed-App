import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { StaffForm } from "../../staff-form";
import { AdminResetForm } from "./admin-reset-form";
import { DeleteForm } from "./delete-form";

export const metadata = {
  title: "Edit staff user — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditStaffUserPage({ params }: Props) {
  const session = await requireAdminStaff();
  const { id } = await params;
  const isSelf = session.user_id === id;
  const admin = createAdminClient();

  const [{ data: profile }, { data: userResp }] = await Promise.all([
    admin
      .from("staff_profiles")
      .select(
        "id, full_name, role, is_active, prc_license_kind, prc_license_no, deleted_at",
      )
      .eq("id", id)
      .maybeSingle(),
    admin.auth.admin.getUserById(id),
  ]);

  if (!profile) notFound();
  const isDeleted = profile.deleted_at !== null;

  const role = profile.role as
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin";
  const prcKind = profile.prc_license_kind as
    | "RMT"
    | "MD"
    | "RT"
    | "pathologist"
    | null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/users"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Staff users
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
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
            prc_license_kind: prcKind,
            prc_license_no: profile.prc_license_no,
          }}
        />
      </div>

      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-6">
        <h2 className="font-heading text-lg font-bold text-amber-900">
          Reset password
        </h2>
        {isSelf ? (
          <p className="mt-1 text-sm text-amber-900/80">
            You can&apos;t reset your own password from here — use{" "}
            <Link
              href="/staff/profile"
              className="underline hover:text-[color:var(--color-brand-navy)]"
            >
              Personal → My profile
            </Link>{" "}
            so the current password check applies.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-amber-900/80">
              Force-resets this user&apos;s password. Use only when the user has
              forgotten it; routine changes should happen via their own{" "}
              <span className="font-mono">/staff/profile</span> page.
            </p>
            <div className="mt-4">
              <AdminResetForm staffUserId={profile.id} />
            </div>
          </>
        )}
      </div>

      {/* Danger zone: delete (admin only, never self, never on already-deleted) */}
      {!isSelf && !isDeleted ? (
        <div className="mt-6 rounded-xl border-2 border-rose-300 bg-rose-50/30 p-6">
          <h2 className="font-heading text-lg font-bold text-rose-900">
            Danger zone
          </h2>
          <div className="mt-3">
            <DeleteForm staffUserId={profile.id} staffName={profile.full_name} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
