import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Patients — staff",
};

interface SearchProps {
  searchParams: Promise<{ q?: string }>;
}

async function search(query: string | undefined) {
  const supabase = await createClient();
  const q = supabase
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone, email, pre_registered, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (query && query.trim()) {
    const term = query.trim();
    const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    q.or(
      [
        `drm_id.ilike.${like}`,
        `first_name.ilike.${like}`,
        `last_name.ilike.${like}`,
        `phone.ilike.${like}`,
        `email.ilike.${like}`,
      ].join(","),
    );
  }

  const { data, error } = await q;
  if (error) {
    console.error("patients search failed", error);
    return [];
  }
  return data ?? [];
}

export default async function PatientsPage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const patients = await search(params.q);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Patients
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Search by DRM-ID, name, phone, or email.
          </p>
        </div>
        <Link
          href="/staff/patients/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New patient
        </Link>
      </header>

      <form className="mb-6 flex max-w-xl gap-2">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="DRM-0001 · Juan dela Cruz · 0916… · email"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <Button
          type="submit"
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Search
        </Button>
      </form>

      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
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
              patients.map((p) => (
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
                      className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                    >
                      {p.last_name}, {p.first_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {p.phone ?? "—"}
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
              ))
            )}
          </tbody>
        </table>
      </div>

      {patients.length === 50 ? (
        <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
          Showing the most recent 50. Refine your search to find older
          records.
        </p>
      ) : null}
    </div>
  );
}
