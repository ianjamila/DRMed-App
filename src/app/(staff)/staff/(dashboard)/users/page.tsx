import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { RestoreButton } from "./restore-button";

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

type StaffRow = {
  id: string;
  full_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  email: string;
};

async function loadStaff(): Promise<{
  existing: StaffRow[];
  deleted: StaffRow[];
  deleterNames: Map<string, string>;
}> {
  const admin = createAdminClient();
  const [{ data: profiles }, { data: usersResp }] = await Promise.all([
    admin
      .from("staff_profiles")
      .select(
        "id, full_name, role, is_active, created_at, deleted_at, deleted_by",
      )
      .order("created_at", { ascending: false }),
    admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
  ]);

  const emailById = new Map<string, string>();
  for (const u of usersResp?.users ?? []) {
    if (u.id && u.email) emailById.set(u.id, u.email);
  }

  const all: StaffRow[] = (profiles ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    role: p.role,
    is_active: p.is_active,
    created_at: p.created_at,
    deleted_at: p.deleted_at,
    deleted_by: p.deleted_by,
    email: emailById.get(p.id) ?? "—",
  }));

  // Build a name lookup for the deleter — we want the deleted table to
  // resolve "Deleted by Crystal Reyes" instead of just the UUID.
  const deleterNames = new Map<string, string>();
  for (const r of all) deleterNames.set(r.id, r.full_name);

  return {
    existing: all.filter((r) => r.deleted_at === null),
    deleted: all.filter((r) => r.deleted_at !== null),
    deleterNames,
  };
}

function formatManila(iso: string): string {
  // Brief, locale-aware presentation of the soft-delete timestamp.
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function StaffUsersPage() {
  await requireAdminStaff();
  const { existing, deleted, deleterNames } = await loadStaff();

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
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

      {/* Existing users */}
      <section>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Existing users
          <span className="ml-2 rounded-md bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-semibold text-[color:var(--color-brand-text-mid)]">
            {existing.length}
          </span>
        </h2>

        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full text-sm">
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
              {existing.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No staff users yet.
                  </td>
                </tr>
              ) : (
                existing.map((u) => (
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
      </section>

      {/* Deleted users — hidden entirely when empty so the section doesn't
          add visual noise to a fresh deployment. */}
      {deleted.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
            Deleted users
            <span className="ml-2 rounded-md bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-900">
              {deleted.length}
            </span>
          </h2>
          <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Rows stay here so audit logs continue to resolve to names. Restore
            to undo the deletion; restoring does not re-activate sign-in —
            edit the user to flip status back to Active.
          </p>

          <div className="overflow-x-auto rounded-xl border border-rose-200 bg-rose-50/30">
            <table className="w-full text-sm">
              <thead className="bg-rose-100/60 text-left text-xs font-bold uppercase tracking-wider text-rose-900/80">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rose-200">
                {deleted.map((u) => (
                  <tr key={u.id} className="hover:bg-rose-50">
                    <td className="px-4 py-3 font-semibold text-rose-900">
                      {u.full_name}
                    </td>
                    <td className="px-4 py-3 text-rose-900/80">{u.email}</td>
                    <td className="px-4 py-3 text-rose-900/80">
                      {ROLE_LABEL[u.role] ?? u.role}
                    </td>
                    <td className="px-4 py-3 text-rose-900/80">
                      <div>{u.deleted_at ? formatManila(u.deleted_at) : "—"}</div>
                      {u.deleted_by ? (
                        <div className="mt-0.5 text-xs text-rose-900/60">
                          by {deleterNames.get(u.deleted_by) ?? "(removed admin)"}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RestoreButton staffUserId={u.id} name={u.full_name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
