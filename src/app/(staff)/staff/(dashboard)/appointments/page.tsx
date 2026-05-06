import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { TransitionButtons } from "./transition-buttons";

export const metadata = {
  title: "Appointments — staff",
};

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-sky-100 text-sky-900",
  arrived: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-red-100 text-red-900",
  no_show: "bg-amber-100 text-amber-900",
  completed: "bg-slate-200 text-slate-700",
};

interface ApptRow {
  id: string;
  scheduled_at: string | null;
  created_at: string;
  status: string;
  notes: string | null;
  walk_in_name: string | null;
  walk_in_phone: string | null;
  patient_id: string | null;
  patient_drm_id: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  service_name: string | null;
  service_code: string | null;
}

async function loadRange(fromIso: string, toIso: string): Promise<ApptRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("appointments")
    .select(
      `
        id, scheduled_at, created_at, status, notes, walk_in_name, walk_in_phone,
        patients ( id, drm_id, first_name, last_name, phone ),
        services ( name, code )
      `,
    )
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso)
    .order("scheduled_at", { ascending: true });

  return (data ?? []).map((a) => {
    const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
    const s = Array.isArray(a.services) ? a.services[0] : a.services;
    return {
      id: a.id,
      scheduled_at: a.scheduled_at,
      created_at: a.created_at,
      status: a.status,
      notes: a.notes,
      walk_in_name: a.walk_in_name,
      walk_in_phone: a.walk_in_phone,
      patient_id: p?.id ?? null,
      patient_drm_id: p?.drm_id ?? null,
      patient_name: p ? `${p.last_name}, ${p.first_name}` : null,
      patient_phone: p?.phone ?? null,
      service_name: s?.name ?? null,
      service_code: s?.code ?? null,
    };
  });
}

export default async function AppointmentsPage() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  // Today / upcoming windows in Manila — Manila is UTC+8 with no DST.
  // eslint-disable-next-line react-hooks/purity -- per-request bounds.
  const nowMs = Date.now();
  const manilaToday = new Date(nowMs + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  // Convert that local-Manila day boundary back to UTC ISO for the query.
  const startOfTodayUtc = new Date(`${manilaToday}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const endOfRangeUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 31 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [today, upcoming] = await Promise.all([
    loadRange(startOfTodayUtc, startOfTomorrowUtc),
    loadRange(startOfTomorrowUtc, endOfRangeUtc),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Appointments
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Public bookings from /schedule plus staff-created appointments.
        </p>
      </header>

      <Section
        title={`Today (${today.length})`}
        rows={today}
        empty="No appointments today."
        isAdmin={session.role === "admin"}
      />
      <Section
        title={`Next 30 days (${upcoming.length})`}
        rows={upcoming}
        empty="No upcoming appointments."
        isAdmin={session.role === "admin"}
      />
    </div>
  );
}

function Section({
  title,
  rows,
  empty,
  isAdmin,
}: {
  title: string;
  rows: ApptRow[];
  empty: string;
  isAdmin: boolean;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-soft)]">
                    {new Date(r.created_at).toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-[color:var(--color-brand-text-mid)]">
                    {r.scheduled_at
                      ? new Date(r.scheduled_at).toLocaleString("en-PH", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : <span className="text-xs italic text-amber-700">Pending callback</span>}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {r.patient_id ? (
                        <Link
                          href={`/staff/patients/${r.patient_id}`}
                          className="hover:text-[color:var(--color-brand-cyan)]"
                        >
                          {r.patient_name}
                        </Link>
                      ) : (
                        <span>{r.walk_in_name ?? "Walk-in"}</span>
                      )}
                    </p>
                    <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.patient_drm_id ?? r.walk_in_phone ?? r.patient_phone ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {r.service_name ?? "—"}
                    </p>
                    <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.service_code ?? ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        STATUS_STYLE[r.status] ?? ""
                      }`}
                    >
                      {r.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <TransitionButtons
                      appointmentId={r.id}
                      patientId={r.patient_id}
                      status={r.status}
                      isAdmin={isAdmin}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
