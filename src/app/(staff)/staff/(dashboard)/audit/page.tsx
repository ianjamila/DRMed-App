import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const metadata = {
  title: "Audit log — staff",
};

const ACTOR_TYPE_STYLE: Record<string, string> = {
  staff: "bg-sky-100 text-sky-900",
  patient: "bg-emerald-100 text-emerald-900",
  system: "bg-slate-200 text-slate-700",
  anonymous: "bg-amber-100 text-amber-900",
};

interface Props {
  searchParams: Promise<{
    action?: string;
    actor?: string;
    drm?: string;
    since?: string;
    until?: string;
    page?: string;
  }>;
}

const PAGE_SIZE = 50;

export default async function AuditLogPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Resolve a DRM-ID to its patient_id once, then filter audit rows by
  // that patient_id. We use the admin client because the staff_profiles
  // RLS policy restricts patient lookups for admins via the same path.
  let patientFilter: { id: string; label: string } | null = null;
  let patientLookupError: string | null = null;
  if (params.drm && params.drm.trim().length > 0) {
    const drm = params.drm.trim().toUpperCase();
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("patients")
      .select("id, drm_id, first_name, last_name")
      .eq("drm_id", drm)
      .maybeSingle();
    if (row) {
      patientFilter = {
        id: row.id,
        label: `${row.last_name}, ${row.first_name} (${row.drm_id})`,
      };
    } else {
      patientLookupError = `No patient with DRM-ID ${drm}.`;
    }
  }

  const supabase = await createClient();
  let query = supabase
    .from("audit_log")
    .select(
      "id, actor_id, actor_type, patient_id, action, resource_type, resource_id, ip_address, created_at, metadata",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (params.action) {
    query = query.ilike("action", `${params.action}%`);
  }
  if (params.actor) {
    query = query.eq("actor_type", params.actor);
  }
  if (patientFilter) {
    query = query.eq("patient_id", patientFilter.id);
  }
  // since: inclusive lower bound on created_at. Treat the date input as a
  // Manila local date and shift to UTC midnight for the comparison.
  if (params.since) {
    const sinceIso = manilaDateStartUtc(params.since);
    if (sinceIso) query = query.gte("created_at", sinceIso);
  }
  if (params.until) {
    const untilIso = manilaDateEndUtc(params.until);
    if (untilIso) query = query.lte("created_at", untilIso);
  }
  if (patientLookupError) {
    // Force an empty result set so the user sees the error message
    // without rows from a broader query confusing the picture.
    query = query.eq("id", -1);
  }

  const { data: rows, count } = await query;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(p: number) {
    const sp = new URLSearchParams();
    if (params.action) sp.set("action", params.action);
    if (params.actor) sp.set("actor", params.actor);
    if (params.drm) sp.set("drm", params.drm);
    if (params.since) sp.set("since", params.since);
    if (params.until) sp.set("until", params.until);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return `/staff/audit${qs ? `?${qs}` : ""}`;
  }

  const hasAnyFilter = Boolean(
    params.action || params.actor || params.drm || params.since || params.until,
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Audit log
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Every patient-data access, every staff action. Read-only — under
          RA 10173, this record cannot be edited.
        </p>
      </header>

      <form className="mb-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <input
          type="search"
          name="action"
          defaultValue={params.action ?? ""}
          placeholder="action prefix · e.g. patient. or result."
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none lg:col-span-2"
        />
        <input
          type="search"
          name="drm"
          defaultValue={params.drm ?? ""}
          placeholder="DRM-ID · e.g. DRM-0042"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <select
          name="actor"
          defaultValue={params.actor ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">Any actor</option>
          <option value="staff">Staff</option>
          <option value="patient">Patient</option>
          <option value="system">System</option>
          <option value="anonymous">Anonymous</option>
        </select>
        <div className="grid grid-cols-2 gap-2 lg:col-span-1">
          <input
            type="date"
            name="since"
            defaultValue={params.since ?? ""}
            aria-label="From date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
          <input
            type="date"
            name="until"
            defaultValue={params.until ?? ""}
            aria-label="To date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>
        <div className="flex gap-2 lg:col-span-5">
          <button
            type="submit"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Filter
          </button>
          {hasAnyFilter ? (
            <Link
              href="/staff/audit"
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {patientFilter ? (
        <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Filtered to <strong>{patientFilter.label}</strong>.
        </p>
      ) : null}
      {patientLookupError ? (
        <p className="mb-3 text-xs text-amber-700" role="alert">
          {patientLookupError}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Resource</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Metadata</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {(rows ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No matching audit entries.
                </td>
              </tr>
            ) : (
              (rows ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-mid)]">
                    {new Date(r.created_at).toLocaleString("en-PH")}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.action}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        ACTOR_TYPE_STYLE[r.actor_type] ?? ""
                      }`}
                    >
                      {r.actor_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                    {r.resource_type ? `${r.resource_type}:${(r.resource_id ?? "").slice(0, 8)}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                    {(r.ip_address as unknown as string) ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {r.metadata ? (
                      <code className="block max-w-[24rem] overflow-x-auto rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-700">
                        {JSON.stringify(r.metadata)}
                      </code>
                    ) : (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-[color:var(--color-brand-text-soft)]">
        <span>
          {total > 0
            ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`
            : "0 entries"}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <a
              href={pageHref(page - 1)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 hover:bg-white"
            >
              ← Prev
            </a>
          ) : null}
          {page < totalPages ? (
            <a
              href={pageHref(page + 1)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 hover:bg-white"
            >
              Next →
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Manila is UTC+8 with no DST, so the start of a Manila date is
// (date) 00:00 PHT = (date) -08:00 UTC. We accept the date input
// (YYYY-MM-DD) as a Manila local date.
function manilaDateStartUtc(yyyymmdd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd}T00:00:00+08:00`;
}

function manilaDateEndUtc(yyyymmdd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd}T23:59:59.999+08:00`;
}
