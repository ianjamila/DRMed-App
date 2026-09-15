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
import { manilaDateTime } from "@/lib/dates/manila";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

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

const BASE_PATH = "/staff/users";

/**
 * Sortable columns for the "Existing users" table.
 *
 * Unlike the patients/critical-alerts sort keys, this value never reaches a
 * PostgREST `.order()` — the row set here is already fully in memory (see
 * the comment on `src/lib/staff/user-filters.ts` for why: email, sign-in
 * method and last-sign-in all come from the Auth admin API, which Postgres
 * can't join). It still goes through the shared `parseSort` allow-list
 * rather than trusting the raw param, so a hand-edited/junk `?sort=` falls
 * back to the default instead of hitting `compareStaffRows`'s `switch` with
 * a key it doesn't handle.
 */
const SORTABLE_COLUMNS = [
  "full_name",
  "email",
  "role",
  "is_active",
  "last_sign_in_at",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

// Alphabetical is the legible default for a "manage these people" screen —
// more useful than the implicit `created_at desc` this page used to render
// in, which only mattered because nothing else was on offer. Last sign-in
// stays one click away for the "who's dormant" view.
const DEFAULT_SORT: SortSpec<SortColumn> = { key: "full_name", dir: "asc" };

// "Never signed in" sinks to the bottom regardless of direction, same rule
// the patients page's NULLS_LAST_COLUMNS applies — otherwise flipping to
// ascending would surface every staff member who's never logged in first.
const NULLS_LAST_COLUMNS = new Set<SortColumn>(["last_sign_in_at"]);

function compareStaffRows(
  a: StaffRow,
  b: StaffRow,
  sort: SortSpec<SortColumn>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  if (NULLS_LAST_COLUMNS.has(sort.key)) {
    const av = a.last_sign_in_at;
    const bv = b.last_sign_in_at;
    if (av === null && bv === null) cmp = 0;
    else if (av === null) return 1; // always last, independent of direction
    else if (bv === null) return -1; // always last, independent of direction
    else cmp = dirMul * av.localeCompare(bv);
  } else {
    switch (sort.key) {
      case "full_name":
        cmp = dirMul * a.full_name.localeCompare(b.full_name);
        break;
      case "email":
        cmp = dirMul * a.email.localeCompare(b.email);
        break;
      case "role":
        cmp = dirMul * roleLabel(a.role).localeCompare(roleLabel(b.role));
        break;
      case "is_active":
        cmp = dirMul * (Number(a.is_active) - Number(b.is_active));
        break;
      default:
        cmp = 0;
    }
  }

  // Tie-break on id, ascending — mirrors the rule every Postgres-ordered
  // list page here follows (table-params.ts) even though `Array#sort` is
  // stable: it keeps the order deterministic rather than depending on that
  // implementation detail, and matches this codebase's "every ordering ends
  // in an id tie-break" convention.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

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
          {manilaDateTime(iso)}
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
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
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
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);

  const { existing, deleted, deleterNames } = await loadStaff();
  const filtered = filterStaffRows(existing, { q, role, status, signIn });
  const total = filtered.length;
  const totalPages = pageCount(total, size);
  const [from, to] = rangeFor(page, size);
  // Sort, then slice — the whole filtered set is already in memory (see the
  // SORTABLE_COLUMNS comment), so pagination here is a plain array slice
  // rather than a second round-trip.
  const rows = [...filtered]
    .sort((a, b) => compareStaffRows(a, b, sort))
    .slice(from, to + 1);

  // Rendered once per request rather than per row, so every relative label on
  // the page is measured from the same instant.
  const now = new Date();

  const onGoogle = existing.filter((u) => u.sign_in.google).length;

  // Params at their default are omitted so the plain filter/sort state stays
  // the bare /staff/users URL.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    q: q.trim() || null,
    role: role !== "all" ? role : null,
    status: status !== "all" ? status : null,
    signin: signIn !== "all" ? signIn : null,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  // Every chip/header keeps the other parameters and resets to page 1 —
  // changing a filter or the sort while sitting on page 7 of a result set
  // that just changed shape is a blank screen with no explanation.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
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
            {filtering ? `${total} of ${existing.length}` : total}
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
                    {th("full_name", "Name")}
                    {th("email", "Email")}
                    <PlainTh label="Sign-in" />
                    {th("last_sign_in_at", "Last sign-in")}
                    {th("role", "Role")}
                    {th("is_active", "Status")}
                    <PlainTh label="Action" align="right" />
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

        <ListPagination
          page={page}
          pageCount={totalPages}
          total={total}
          size={size}
          prevHref={
            page > 1
              ? buildListHref(BASE_PATH, baseParams, {
                  page: page - 1 > 1 ? String(page - 1) : null,
                })
              : null
          }
          nextHref={
            page < totalPages
              ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) })
              : null
          }
          sizeOptions={PAGE_SIZES.map((s) => ({
            size: s,
            href: href({ size: s === DEFAULT_PAGE_SIZE ? null : String(s) }),
          }))}
          noun="staff user"
        />
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
                      <div>{u.deleted_at ? manilaDateTime(u.deleted_at) : "—"}</div>
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
