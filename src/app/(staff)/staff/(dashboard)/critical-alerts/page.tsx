import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { AcknowledgeButton } from "./acknowledge-button";

export const metadata = {
  title: "Critical alerts — staff",
};

type AlertRow = {
  id: string;
  created_at: string;
  parameter_name: string;
  direction: string;
  observed_value_si: number | null;
  threshold_si: number | null;
  test_request_id: string;
  patient_drm_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  patients: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

function manila(ts: string): string {
  return new Date(ts).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

function patientName(row: AlertRow): string {
  const p = Array.isArray(row.patients) ? row.patients[0] : row.patients;
  return p ? `${p.last_name}, ${p.first_name}` : "—";
}

function DirectionBadge({ direction }: { direction: string }) {
  const high = direction === "high";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${
        high ? "bg-red-100 text-red-900" : "bg-sky-100 text-sky-900"
      }`}
    >
      {high ? "↑ High" : "↓ Low"}
    </span>
  );
}

export default async function CriticalAlertsPage() {
  const session = await requireActiveStaff();

  if (session.role !== "pathologist" && session.role !== "admin") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Critical alerts
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
          This page is for pathologists and admins — critical-value follow-up
          is a clinical responsibility.
        </p>
      </div>
    );
  }

  const supabase = await createClient();

  const alertSelect = `
    id, created_at, parameter_name, direction, observed_value_si,
    threshold_si, test_request_id, patient_drm_id, acknowledged_at,
    acknowledged_by,
    patients ( first_name, last_name )
  `;

  const [{ data: unackedRaw }, { data: recentRaw }] = await Promise.all([
    supabase
      .from("critical_alerts")
      .select(alertSelect)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("critical_alerts")
      .select(alertSelect)
      .not("acknowledged_at", "is", null)
      .order("acknowledged_at", { ascending: false })
      .limit(50),
  ]);

  const unacked = (unackedRaw ?? []) as AlertRow[];
  const recent = (recentRaw ?? []) as AlertRow[];

  // Resolve acknowledger names for the recent list.
  const ackerIds = Array.from(
    new Set(
      recent.map((r) => r.acknowledged_by).filter((v): v is string => !!v),
    ),
  );
  const ackerNames = new Map<string, string>();
  if (ackerIds.length > 0) {
    const { data: profs } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", ackerIds);
    for (const p of profs ?? []) ackerNames.set(p.id, p.full_name);
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Critical alerts"
        subtitle="Results that crossed a critical threshold. Acknowledge each after the clinical follow-up call — acknowledgement is audit-logged."
      />

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Parameter</th>
              <th className="px-4 py-3">Observed vs threshold</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {unacked.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No unacknowledged critical alerts. 🎉
                </td>
              </tr>
            ) : (
              unacked.map((a) => (
                <tr key={a.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {manila(a.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {patientName(a)}
                    </p>
                    <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {a.patient_drm_id ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {a.parameter_name}
                    </p>
                    <DirectionBadge direction={a.direction} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                    {a.observed_value_si ?? "?"} (threshold{" "}
                    {a.threshold_si ?? "?"})
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/staff/queue/${a.test_request_id}`}
                      className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Open test →
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AcknowledgeButton alertId={a.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <summary className="cursor-pointer px-5 py-4 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Recently acknowledged ({recent.length}, last 50)
        </summary>
        <div className="overflow-x-auto border-t border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Parameter</th>
                <th className="px-4 py-3">Observed vs threshold</th>
                <th className="px-4 py-3">Acknowledged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {recent.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    Nothing acknowledged yet.
                  </td>
                </tr>
              ) : (
                recent.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manila(a.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {patientName(a)}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {a.patient_drm_id ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {a.parameter_name}
                      </p>
                      <DirectionBadge direction={a.direction} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                      {a.observed_value_si ?? "?"} (threshold{" "}
                      {a.threshold_si ?? "?"})
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {a.acknowledged_at ? manila(a.acknowledged_at) : "—"}
                      <span className="block text-[color:var(--color-brand-text-soft)]">
                        by{" "}
                        {a.acknowledged_by
                          ? (ackerNames.get(a.acknowledged_by) ?? "—")
                          : "—"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
