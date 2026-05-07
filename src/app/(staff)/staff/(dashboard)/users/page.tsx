import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = {
  title: "Staff users — staff",
};

const ROLE_LABEL: Record<string, string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};

async function loadStaffWithEmails() {
  const admin = createAdminClient();
  const [{ data: profiles }, { data: usersResp }] = await Promise.all([
    admin
      .from("staff_profiles")
      .select("id, full_name, role, is_active, created_at")
      .order("created_at", { ascending: false }),
    admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
  ]);
  const emailById = new Map<string, string>();
  for (const u of usersResp?.users ?? []) {
    if (u.id && u.email) emailById.set(u.id, u.email);
  }
  return (profiles ?? []).map((p) => ({
    ...p,
    email: emailById.get(p.id) ?? "—",
  }));
}

export default async function StaffUsersPage() {
  await requireAdminStaff();
  const staff = await loadStaffWithEmails();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Staff users
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Manage who can sign into the staff portal and what role they have.
          </p>
        </div>
        <Link
          href="/staff/users/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New staff user
        </Link>
      </header>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[700px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {staff.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No staff users yet.
                </td>
              </tr>
            ) : (
              staff.map((u) => (
                <tr
                  key={u.id}
                  className="hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                    {u.full_name}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {u.email}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {ROLE_LABEL[u.role] ?? u.role}
                  </td>
                  <td className="px-4 py-3">
                    {u.is_active ? (
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/users/${u.id}/edit`}
                      className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Edit →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
