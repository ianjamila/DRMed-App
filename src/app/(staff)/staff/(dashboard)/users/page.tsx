import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  summarizeSignInMethods,
  type SignInSummary,
} from "@/lib/auth/sign-in-methods";
import {
  filterStaffRows,
  parseRoleFilter,
  parseSignInFilter,
  parseStatusFilter,
  roleLabel,
  STAFF_ROLES,
  type SignInFilter,
  type StaffRoleFilter,
  type StaffStatusFilter,
} from "@/lib/staff/user-filters";
import { relativeSignIn } from "@/lib/staff/last-sign-in";
import { StaffSearchInput } from "./search-input";
import { RestoreButton } from "./restore-button";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "Staff users — staff",
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
  sign_in: SignInSummary;
  last_sign_in_at: string | null;
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

  // One pass over the auth users for all three things the table needs from
  // them. Sign-in method and last-sign-in come free with the call that was
  // already being made for emails — none of it is queryable from Postgres,
  // since auth.identities is not exposed through PostgREST.
  const emailById = new Map<string, string>();
  const signInById = new Map<string, SignInSummary>();
  const lastSignInById = new Map<string, string | null>();
  for (const u of usersResp?.users ?? []) {
    if (!u.id) continue;
    if (u.email) emailById.set(u.id, u.email);
    signInById.set(u.id, summarizeSignInMethods(u.identities));
    lastSignInById.set(u.id, u.last_sign_in_at ?? null);
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
    sign_in: signInById.get(p.id) ?? { google: false, password: false },
    last_sign_in_at: lastSignInById.get(p.id) ?? null,
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
  // Brief, locale-aware presentation of a timestamp.
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="rounded-md bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-semibold text-[color:var(--color-brand-text-mid)]">
      {roleLabel(role)}
    </span>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
      Active
    </span>
  ) : (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
      Inactive
    </span>
  );
}

// Shows at a glance who still needs moving onto Google. A row with only
// "Password" has not signed in with Google yet; "Neither" should never appear
// for a real staff member and means the auth user has no identity rows at all.
function SignInBadges({ summary }: { summary: SignInSummary }) {
  if (!summary.google && !summary.password) {
    return (
      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
        Neither
      </span>
    );
  }

  return (
    <span className="flex flex-wrap gap-1">
      {summary.google ? (
        <span className="rounded-md bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-900">
          Google
        </span>
      ) : null}
      {summary.password ? (
        <span className="rounded-md bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
          Password
        </span>
      ) : null}
    </span>
  );
}

// An admin's own row deliberately has no sign-in email or password panel on
// its edit page (both are self-service under Personal → My profile). Marking
// the row keeps that from reading as a missing feature.
function YouChip() {
  return (
    <span className="ml-2 rounded-md bg-[color:var(--color-brand-cyan)]/15 px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-[color:var(--color-brand-navy)]">
      You
    </span>
  );
}

function LastSignIn({ iso, now }: { iso: string | null; now: Date }) {
  return (
    <>
      <div>{relativeSignIn(iso, now)}</div>
      {iso ? (
        <div className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
          {formatManila(iso)}
        </div>
      ) : null}
    </>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
          : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      {children}
    </Link>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
    </div>
  );
}

interface SearchProps {
  searchParams: Promise<{
    q?: string;
    role?: string;
    status?: string;
    signin?: string;
  }>;
}

export default async function StaffUsersPage({ searchParams }: SearchProps) {
  const session = await requireAdminStaff();
  const params = await searchParams;

  const q = params.q ?? "";
  const role: StaffRoleFilter = parseRoleFilter(params.role);
  const status: StaffStatusFilter = parseStatusFilter(params.status);
  const signIn: SignInFilter = parseSignInFilter(params.signin);
  const filtering =
    q.trim() !== "" || role !== "all" || status !== "all" || signIn !== "all";

  const { existing, deleted, deleterNames } = await loadStaff();
  const rows = filterStaffRows(existing, { q, role, status, signIn });

  // Rendered once per request rather than per row, so every relative label on
  // the page is measured from the same instant.
  const now = new Date();

  const onGoogle = existing.filter((u) => u.sign_in.google).length;

  // Every chip keeps the other three parameters, so filters compose.
  const href = (patch: {
    role?: StaffRoleFilter;
    status?: StaffStatusFilter;
    signin?: SignInFilter;
  }) => {
    const merged = { role, status, signin: signIn, ...patch };
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (merged.role !== "all") sp.set("role", merged.role);
    if (merged.status !== "all") sp.set("status", merged.status);
    if (merged.signin !== "all") sp.set("signin", merged.signin);
    return `/staff/users${sp.size ? `?${sp.toString()}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Staff users"
        subtitle="Manage who can sign into the staff portal and what role they have."
        actions={
          <Link
            href="/staff/users/new"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            + New staff user
          </Link>
        }
      />

      {/* Migration progress. Staff are being moved from passwords onto Google
          sign-in one at a time, so the headline number is "how far along". */}
      {existing.length > 0 ? (
        <p className="mb-4 text-sm text-[color:var(--color-brand-text-mid)]">
          <span className="font-bold text-[color:var(--color-brand-navy)]">
            {onGoogle} of {existing.length}
          </span>{" "}
          staff sign in with Google.
          {onGoogle < existing.length ? (
            <>
              {" "}
              <Link
                href={href({ signin: "password_only" })}
                className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Show the {existing.length - onGoogle} still on a password →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="mb-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <StaffSearchInput initialQuery={q} />

        <FilterRow label="Role">
          <Chip href={href({ role: "all" })} active={role === "all"}>
            All
          </Chip>
          {STAFF_ROLES.map((r) => (
            <Chip key={r} href={href({ role: r })} active={role === r}>
              {roleLabel(r)}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="Status">
          <Chip href={href({ status: "all" })} active={status === "all"}>
            All
          </Chip>
          <Chip href={href({ status: "active" })} active={status === "active"}>
            Active
          </Chip>
          <Chip
            href={href({ status: "inactive" })}
            active={status === "inactive"}
          >
            Inactive
          </Chip>
        </FilterRow>

        <FilterRow label="Sign-in">
          <Chip href={href({ signin: "all" })} active={signIn === "all"}>
            All
          </Chip>
          <Chip href={href({ signin: "google" })} active={signIn === "google"}>
            Google
          </Chip>
          <Chip
            href={href({ signin: "password_only" })}
            active={signIn === "password_only"}
          >
            Password only
          </Chip>
        </FilterRow>
      </div>

      {/* Existing users */}
      <section>
        <h2 className="mb-3 font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Existing users
          <span className="ml-2 rounded-md bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-semibold text-[color:var(--color-brand-text-mid)]">
            {filtering ? `${rows.length} of ${existing.length}` : rows.length}
          </span>
        </h2>

        {rows.length === 0 ? (
          <Panel className="p-8 text-center">
            <p className="text-sm text-[color:var(--color-brand-text-soft)]">
              {existing.length === 0
                ? "No staff users yet."
                : "No staff users match these filters."}
            </p>
            {filtering && existing.length > 0 ? (
              <Link
                href="/staff/users"
                className="mt-2 inline-block text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Clear filters
              </Link>
            ) : null}
          </Panel>
        ) : (
          <>
            {/* Phones: the five-column table scrolls sideways, which is a poor
                way to read a staff list. Same data, stacked. */}
            <ul className="grid gap-3 sm:hidden">
              {rows.map((u) => (
                <li key={u.id}>
                  <Panel className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div
                          className={`font-semibold ${
                            u.is_active
                              ? "text-[color:var(--color-brand-navy)]"
                              : "text-[color:var(--color-brand-text-soft)]"
                          }`}
                        >
                          {u.full_name}
                          {u.id === session.user_id ? <YouChip /> : null}
                        </div>
                        <div className="mt-1 text-sm text-[color:var(--color-brand-text-mid)]">
                          {u.email}
                        </div>
                      </div>
                      <Link
                        href={`/staff/users/${u.id}/edit`}
                        className="shrink-0 text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Edit →
                      </Link>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <RoleBadge role={u.role} />
                      <StatusBadge isActive={u.is_active} />
                      <SignInBadges summary={u.sign_in} />
                    </div>

                    <div className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
                      Last sign-in: {relativeSignIn(u.last_sign_in_at, now)}
                    </div>
                  </Panel>
                </li>
              ))}
            </ul>

            <Panel className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Sign-in</th>
                    <th className="px-4 py-3">Last sign-in</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {rows.map((u) => (
                    <tr
                      key={u.id}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td
                        className={`px-4 py-3 font-semibold ${
                          u.is_active
                            ? "text-[color:var(--color-brand-navy)]"
                            : "text-[color:var(--color-brand-text-soft)]"
                        }`}
                      >
                        {u.full_name}
                        {u.id === session.user_id ? <YouChip /> : null}
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        {u.email}
                      </td>
                      <td className="px-4 py-3">
                        <SignInBadges summary={u.sign_in} />
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        <LastSignIn iso={u.last_sign_in_at} now={now} />
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge isActive={u.is_active} />
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
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </section>

      {/* Deleted users — hidden entirely when empty so the section doesn't
          add visual noise to a fresh deployment. Deliberately NOT filtered:
          this is an archive kept so audit logs resolve to names, and hiding
          rows from it would make a deleted person look permanently gone. */}
      {deleted.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-3 font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
            Deleted users
            <span className="ml-2 rounded-md bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-900">
              {deleted.length}
            </span>
          </h2>
          <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Rows stay here so audit logs continue to resolve to names. Restore
            to undo the deletion; restoring does not re-activate sign-in — edit
            the user to flip status back to Active.
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
                      {roleLabel(u.role)}
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
