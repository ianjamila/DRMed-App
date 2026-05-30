import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatPhoneLocal } from "@/lib/format/phone";
import { patientSearchOrClauses } from "@/lib/patients/search";
import { PatientsSearchInput } from "./search-input";

export const metadata = {
  title: "Patients — staff",
};

interface SearchProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

const PAGE_SIZE = 50;

async function search(query: string | undefined, page: number) {
  const supabase = await createClient();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = supabase
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, phone, email, pre_registered, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  // Token-based: every word must match some field (any order), so "Jamila, Ian"
  // finds a patient stored as first_name="Ian", last_name="Jamila".
  for (const clause of patientSearchOrClauses(query)) {
    q = q.or(clause);
  }

  const { data, error, count } = await q;
  if (error) {
    console.error("patients search failed", error);
    return { rows: [], total: 0 };
  }
  return { rows: data ?? [], total: count ?? 0 };
}

export default async function PatientsPage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const query = params.q ?? "";
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const { rows: patients, total } = await search(query, page);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  const pageHref = (n: number) => {
    const sp = new URLSearchParams();
    if (query) sp.set("q", query);
    if (n > 1) sp.set("page", String(n));
    return `/staff/patients${sp.size ? `?${sp.toString()}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Patients
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Search by DRM-ID, name, phone, or email — filters as you type.
          </p>
        </div>
        <Link
          href="/staff/patients/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New patient
        </Link>
      </header>

      <div className="mb-6">
        <PatientsSearchInput initialQuery={query} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">DRM-ID</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {patients.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No patients match.
                </td>
              </tr>
            ) : (
              patients.map((p) => {
                const displayName =
                  p.last_name?.trim() || p.first_name?.trim()
                    ? `${p.last_name ?? ""}${p.last_name && p.first_name ? ", " : ""}${p.first_name ?? ""}`
                    : "—";
                return (
                  <tr
                    key={p.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                      <Link
                        href={`/staff/patients/${p.id}`}
                        className="hover:text-[color:var(--color-brand-cyan)]"
                      >
                        {p.drm_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/patients/${p.id}`}
                        className={
                          displayName === "—"
                            ? "italic text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-cyan)]"
                            : "font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                        }
                      >
                        {displayName === "—" ? "(no name on file)" : displayName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {p.phone ? formatPhoneLocal(p.phone) : "—"}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {p.email ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {p.pre_registered ? (
                        <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                          Pre-registered · verify
                        </span>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          Verified
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--color-brand-text-soft)]">
        <p>
          {total === 0
            ? "0 patients"
            : `Showing ${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${total.toLocaleString()}`}
        </p>
        {totalPages > 1 && (
          <nav className="flex items-center gap-1" aria-label="Pagination">
            <PageLink href={pageHref(1)} disabled={page === 1} label="«" title="First" />
            <PageLink href={pageHref(page - 1)} disabled={page === 1} label="‹" title="Previous" />
            <span className="px-2 py-1 text-[color:var(--color-brand-navy)]">
              Page {page} of {totalPages}
            </span>
            <PageLink href={pageHref(page + 1)} disabled={page === totalPages} label="›" title="Next" />
            <PageLink href={pageHref(totalPages)} disabled={page === totalPages} label="»" title="Last" />
          </nav>
        )}
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
  title,
}: {
  href: string;
  disabled: boolean;
  label: string;
  title: string;
}) {
  const cls =
    "rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 font-mono " +
    (disabled
      ? "cursor-not-allowed bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)] opacity-50"
      : "bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]");
  if (disabled) {
    return (
      <span className={cls} aria-disabled="true" title={title}>
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className={cls} title={title}>
      {label}
    </Link>
  );
}
