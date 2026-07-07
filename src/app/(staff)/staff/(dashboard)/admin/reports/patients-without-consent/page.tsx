import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Patients without consent — staff" };
export const dynamic = "force-dynamic";

// Same hard cap as the other admin reports so the list can't pull an unbounded
// scan into one render.
const MAX_ROWS = 500;

const manilaDate = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
});

export default async function PatientsWithoutConsentPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // Active patients (not merged tombstones) with no current data-privacy
  // consent on file. These are exactly the rows whose result releases will
  // block once the consent gate is switched ON.
  const { data: patients } = await admin
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone, email, pre_registered")
    .eq("consent_current", false)
    .is("merged_into_id", null)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  const rows = patients ?? [];
  const capped = rows.length === MAX_ROWS;

  // Visit stats (count + most recent visit date) via a second batched query,
  // then folded onto each patient.
  const patientIds = rows.map((p) => p.id);
  const visitCount = new Map<string, number>();
  const lastVisit = new Map<string, string>();
  if (patientIds.length > 0) {
    const { data: visits } = await admin
      .from("visits")
      .select("patient_id, visit_date")
      .in("patient_id", patientIds);
    for (const v of visits ?? []) {
      if (!v.patient_id) continue;
      visitCount.set(v.patient_id, (visitCount.get(v.patient_id) ?? 0) + 1);
      if (v.visit_date) {
        const prev = lastVisit.get(v.patient_id);
        if (!prev || v.visit_date > prev) lastVisit.set(v.patient_id, v.visit_date);
      }
    }
  }

  // Order by last visit desc (most recently active first); patients with no
  // visits sink to the bottom.
  const ordered = [...rows].sort((a, b) => {
    const av = lastVisit.get(a.id) ?? "";
    const bv = lastVisit.get(b.id) ?? "";
    return bv.localeCompare(av);
  });

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Patients without consent
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Active patients with no data-privacy consent on file (RA 10173). Once
          the consent gate is switched ON, results cannot be released for anyone
          on this list — clear it to zero first. Capture consent from each
          patient&apos;s record (printed form, on-screen signature, or the
          patient accepting the notice in their portal).
        </p>
        <p className="mt-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {rows.length} {rows.length === 1 ? "patient" : "patients"} without
          consent
          {capped ? " (showing the first 500)" : ""}.{" "}
          <Link
            href="/staff/admin/settings/consent-gate"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Consent-gate settings →
          </Link>
        </p>
      </header>

      {capped ? (
        <p className="mt-4 text-xs text-amber-700">
          Showing the most recent {MAX_ROWS} — clear these and reload to see the
          rest.
        </p>
      ) : null}

      <Panel className="mt-6 overflow-hidden">
        {ordered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            Every active patient has consent on file. Safe to enable the consent
            gate.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">DRM-ID</th>
                  <th className="px-4 py-3 text-right">Visits</th>
                  <th className="px-4 py-3">Last visit</th>
                  <th className="px-4 py-3">Contact on file</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {ordered.map((p) => {
                  const name =
                    `${p.last_name ?? ""}${p.last_name && p.first_name ? ", " : ""}${p.first_name ?? ""}`.trim() ||
                    "(no name on file)";
                  const last = lastVisit.get(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/patients/${p.id}#consent`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {name}
                        </Link>
                        {p.pre_registered ? (
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                            Pre-registered
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {p.drm_id}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {visitCount.get(p.id) ?? 0}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {last ? (
                          manilaDate.format(new Date(`${last}T00:00:00+08:00`))
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            No visits
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-1.5">
                          <ContactPill present={!!p.phone} label="Phone" />
                          <ContactPill present={!!p.email} label="Email" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ContactPill({ present, label }: { present: boolean; label: string }) {
  return present ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
      {label}
    </span>
  ) : (
    <span className="rounded-full bg-[color:var(--color-brand-bg-mid)] px-2 py-0.5 text-[color:var(--color-brand-text-soft)]">
      No {label.toLowerCase()}
    </span>
  );
}
