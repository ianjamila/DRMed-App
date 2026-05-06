import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { RealtimeRefresher } from "@/components/staff/realtime-refresher";
import { TransitionButtons } from "./transition-buttons";

export const metadata = {
  title: "Appointments — staff",
};

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  pending_callback: "bg-amber-100 text-amber-900",
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
  booking_group_id: string | null;
  home_service_requested: boolean;
}

interface ApptGroup {
  // Stable key: booking_group_id when present, otherwise the appointment id.
  key: string;
  // Lead row drives patient + scheduled_at + status display. All rows in a
  // group share these because the bulk transition action keeps them in sync.
  lead: ApptRow;
  rows: ApptRow[];
}

const APPT_SELECT = `
  id, scheduled_at, created_at, status, notes,
  walk_in_name, walk_in_phone, booking_group_id, home_service_requested,
  patients ( id, drm_id, first_name, last_name, phone ),
  services ( name, code )
`;

function rowFrom(a: {
  id: string;
  scheduled_at: string | null;
  created_at: string;
  status: string;
  notes: string | null;
  walk_in_name: string | null;
  walk_in_phone: string | null;
  booking_group_id: string | null;
  home_service_requested: boolean;
  patients?:
    | {
        id: string;
        drm_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
      }
    | Array<{
        id: string;
        drm_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
      }>
    | null;
  services?:
    | { name: string; code: string }
    | Array<{ name: string; code: string }>
    | null;
}): ApptRow {
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
    booking_group_id: a.booking_group_id,
    home_service_requested: a.home_service_requested,
  };
}

function groupRows(rows: ApptRow[]): ApptGroup[] {
  const groups: ApptGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const r of rows) {
    const key = r.booking_group_id ?? r.id;
    const idx = indexByKey.get(key);
    if (idx == null) {
      indexByKey.set(key, groups.length);
      groups.push({ key, lead: r, rows: [r] });
    } else {
      groups[idx]!.rows.push(r);
    }
  }
  return groups;
}

async function loadScheduledRange(
  fromIso: string,
  toIso: string,
): Promise<ApptRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("appointments")
    .select(APPT_SELECT)
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso)
    .order("scheduled_at", { ascending: true });
  return (data ?? []).map(rowFrom);
}

async function loadWalkInsCreatedToday(
  fromIso: string,
  toIso: string,
): Promise<ApptRow[]> {
  // Confirmed appointments without a specific scheduled_at — the lab
  // walk-in path. Show them in today's queue when reception created them
  // (or a public booking landed) within the day.
  const supabase = await createClient();
  const { data } = await supabase
    .from("appointments")
    .select(APPT_SELECT)
    .is("scheduled_at", null)
    .eq("status", "confirmed")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: true });
  return (data ?? []).map(rowFrom);
}

async function loadPendingCallback(): Promise<ApptRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("appointments")
    .select(APPT_SELECT)
    .eq("status", "pending_callback")
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []).map(rowFrom);
}

export default async function AppointmentsPage() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  // eslint-disable-next-line react-hooks/purity -- per-request bounds.
  const nowMs = Date.now();
  const manilaToday = new Date(nowMs + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const startOfTodayUtc = new Date(`${manilaToday}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const endOfRangeUtc = new Date(
    new Date(`${manilaToday}T00:00:00+08:00`).getTime() + 31 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [todayScheduled, todayWalkIns, upcoming, pending] = await Promise.all([
    loadScheduledRange(startOfTodayUtc, startOfTomorrowUtc),
    loadWalkInsCreatedToday(startOfTodayUtc, startOfTomorrowUtc),
    loadScheduledRange(startOfTomorrowUtc, endOfRangeUtc),
    loadPendingCallback(),
  ]);

  const todayRows = [...todayScheduled, ...todayWalkIns];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="appointments-page"
        subscriptions={[
          { table: "appointments", event: "INSERT" },
          { table: "appointments", event: "UPDATE" },
        ]}
      />
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Appointments
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Public bookings from /schedule plus staff-created appointments.
          Multi-service requests are grouped — one card with all picked
          tests, single set of action buttons.
        </p>
      </header>

      <Section
        title={`Pending callback (${groupRows(pending).length})`}
        groups={groupRows(pending)}
        empty="No pending callbacks. Nice."
        isAdmin={session.role === "admin"}
      />
      <Section
        title={`Today (${groupRows(todayRows).length})`}
        groups={groupRows(todayRows)}
        empty="No appointments today."
        isAdmin={session.role === "admin"}
      />
      <Section
        title={`Next 30 days (${groupRows(upcoming).length})`}
        groups={groupRows(upcoming)}
        empty="No upcoming appointments."
        isAdmin={session.role === "admin"}
      />
    </div>
  );
}

function Section({
  title,
  groups,
  empty,
  isAdmin,
}: {
  title: string;
  groups: ApptGroup[];
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
              <th className="px-4 py-3">Services</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {groups.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {empty}
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <GroupRow key={g.key} group={g} isAdmin={isAdmin} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GroupRow({
  group,
  isAdmin,
}: {
  group: ApptGroup;
  isAdmin: boolean;
}) {
  const r = group.lead;
  const ids = group.rows.map((row) => row.id);
  return (
    <tr className="align-top hover:bg-[color:var(--color-brand-bg)]">
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
        {r.scheduled_at ? (
          new Date(r.scheduled_at).toLocaleString("en-PH", {
            dateStyle: "medium",
            timeStyle: "short",
          })
        ) : r.status === "pending_callback" ? (
          <span className="text-xs italic text-amber-700">
            Pending callback
          </span>
        ) : (
          <span className="text-xs italic text-sky-700">Walk-in</span>
        )}
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
        {r.home_service_requested ? (
          <p className="mt-1 inline-block rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-900">
            Home service
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3">
        {group.rows.length === 1 ? (
          <>
            <p className="font-semibold text-[color:var(--color-brand-navy)]">
              {r.service_name ?? "—"}
            </p>
            <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
              {r.service_code ?? ""}
            </p>
          </>
        ) : (
          <ul className="space-y-1">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="text-[color:var(--color-brand-text-mid)]"
              >
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {row.service_name ?? "—"}
                </span>
                <span className="ml-2 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {row.service_code ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
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
          appointmentIds={ids}
          patientId={r.patient_id}
          status={r.status}
          isAdmin={isAdmin}
          groupSize={group.rows.length}
        />
      </td>
    </tr>
  );
}
