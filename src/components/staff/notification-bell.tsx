"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  sectionsForRole,
  type ServiceSection,
} from "@/lib/auth/role-sections";
import type { StaffSession } from "@/lib/auth/require-staff";

interface NotificationItem {
  id: string;
  kind: "appointment" | "test_request" | "critical_alert";
  title: string;
  subtitle: string;
  href: string;
  ts: number;
  // Critical alerts get a louder visual treatment (red badge + icon).
  severity?: "info" | "critical";
}

interface Props {
  role: StaffSession["role"];
}

const MAX_ITEMS = 10;

// Roles that listen on the appointments table.
const APPT_ROLES: ReadonlyArray<StaffSession["role"]> = ["reception", "admin"];
// Roles that listen on the test_requests table (lab/imaging queue work).
const QUEUE_ROLES: ReadonlyArray<StaffSession["role"]> = [
  "medtech",
  "xray_technician",
  "admin",
];
// Roles that listen on critical_alerts. Pathologist owns clinical
// follow-up; admin observes for compliance.
const CRITICAL_ROLES: ReadonlyArray<StaffSession["role"]> = [
  "pathologist",
  "admin",
];

export function NotificationBell({ role }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  // Service id → section map. Loaded once on mount so test_requests
  // realtime payloads (which only carry service_id) can be filtered by
  // role without an extra query per event.
  const sectionByServiceRef = useRef<Map<string, ServiceSection | null>>(
    new Map(),
  );

  const allowedSections = useMemo(() => {
    const list = sectionsForRole(role);
    return list === null ? null : new Set<ServiceSection>(list);
  }, [role]);

  const supabase = useMemo(() => createClient(), []);

  const subscribesToAppointments = APPT_ROLES.includes(role);
  const subscribesToQueue = QUEUE_ROLES.includes(role);
  const subscribesToCritical = CRITICAL_ROLES.includes(role);

  const pushItem = useCallback((item: NotificationItem) => {
    setItems((prev) => [item, ...prev].slice(0, MAX_ITEMS));
    setUnread((n) => n + 1);
  }, []);

  // Load the service_id → section map once for queue subscribers.
  useEffect(() => {
    if (!subscribesToQueue) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("services")
        .select("id, section");
      if (cancelled || !data) return;
      const map = new Map<string, ServiceSection | null>();
      for (const r of data) {
        map.set(r.id, (r.section as ServiceSection | null) ?? null);
      }
      sectionByServiceRef.current = map;
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, subscribesToQueue]);

  // Subscriptions.
  useEffect(() => {
    if (
      !subscribesToAppointments &&
      !subscribesToQueue &&
      !subscribesToCritical
    )
      return;

    // Unique per-mount name. Reusing "staff-notifications" hits a Supabase
    // singleton: a re-mount returns the already-subscribed channel and
    // .on() throws, looping React commits until the tab crashes.
    const channel = supabase.channel(
      `staff-notifications-${Math.random().toString(36).slice(2)}`,
    );

    if (subscribesToAppointments) {
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "appointments" },
        async (payload) => {
          const row = payload.new as {
            id: string;
            patient_id: string | null;
            service_id: string | null;
            status: string;
            scheduled_at: string | null;
            walk_in_name: string | null;
          };
          const [{ data: patient }, { data: svc }] = await Promise.all([
            row.patient_id
              ? supabase
                  .from("patients")
                  .select("first_name, last_name, drm_id")
                  .eq("id", row.patient_id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
            row.service_id
              ? supabase
                  .from("services")
                  .select("name")
                  .eq("id", row.service_id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          const who =
            patient?.first_name || patient?.last_name
              ? `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim()
              : (row.walk_in_name ?? "New booking");
          const what = svc?.name ?? "appointment";
          const flag =
            row.status === "pending_callback"
              ? " · awaiting callback"
              : "";
          pushItem({
            id: row.id,
            kind: "appointment",
            title: `${who} booked ${what}`,
            subtitle: `${formatTime(new Date())}${flag}`,
            href: "/staff/appointments",
            ts: Date.now(),
          });
        },
      );
    }

    if (subscribesToQueue) {
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "test_requests" },
        async (payload) => {
          const row = payload.new as {
            id: string;
            service_id: string;
            visit_id: string;
            status: string;
          };
          // Section filter: skip rows outside this role's bench.
          if (allowedSections) {
            const section = sectionByServiceRef.current.get(row.service_id);
            if (!section || !allowedSections.has(section)) return;
          }
          const [{ data: svc }, { data: visit }] = await Promise.all([
            supabase
              .from("services")
              .select("name, code")
              .eq("id", row.service_id)
              .maybeSingle(),
            supabase
              .from("visits")
              .select(
                "visit_number, patients ( first_name, last_name, drm_id )",
              )
              .eq("id", row.visit_id)
              .maybeSingle(),
          ]);
          const patient = Array.isArray(visit?.patients)
            ? visit?.patients[0]
            : visit?.patients;
          const who = patient
            ? `${patient.first_name} ${patient.last_name}`.trim()
            : "—";
          pushItem({
            id: row.id,
            kind: "test_request",
            title: `${svc?.name ?? "Test"} for ${who}`,
            subtitle: `Visit #${visit?.visit_number ?? "?"} · ${formatTime(new Date())}`,
            href: `/staff/queue/${row.id}`,
            ts: Date.now(),
          });
        },
      );
    }

    if (subscribesToCritical) {
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "critical_alerts" },
        (payload) => {
          const row = payload.new as {
            id: string;
            test_request_id: string;
            parameter_name: string;
            direction: "low" | "high";
            observed_value_si: number | null;
            threshold_si: number | null;
            patient_drm_id: string | null;
          };
          const dir = row.direction === "high" ? "↑ HIGH" : "↓ LOW";
          pushItem({
            id: row.id,
            kind: "critical_alert",
            title: `${dir} · ${row.parameter_name}`,
            subtitle: `${row.patient_drm_id ?? "—"} · observed ${row.observed_value_si ?? "?"} (threshold ${row.threshold_si ?? "?"})`,
            href: `/staff/queue/${row.test_request_id}`,
            ts: Date.now(),
            severity: "critical",
          });
        },
      );
    }

    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [
    supabase,
    subscribesToAppointments,
    subscribesToQueue,
    subscribesToCritical,
    allowedSections,
    pushItem,
  ]);

  // Hide the bell for roles that don't subscribe to anything. Keeps
  // the header tidy for staff who only act on the dashboard.
  if (
    !subscribesToAppointments &&
    !subscribesToQueue &&
    !subscribesToCritical
  )
    return null;

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) setUnread(0);
      return next;
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleToggle}
        className="relative grid h-11 w-11 place-items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
      >
        <BellIcon />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-2 shadow-lg md:left-0 md:right-auto"
          role="menu"
        >
          <div className="flex items-baseline justify-between px-2 pb-2 pt-1">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Notifications
            </p>
            {items.length > 0 ? (
              <button
                type="button"
                onClick={() => setItems([])}
                className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Clear
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[color:var(--color-brand-text-soft)]">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {items.map((item) => {
                const isCritical = item.severity === "critical";
                return (
                  <li key={`${item.kind}-${item.id}-${item.ts}`}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={`block rounded-md px-2 py-2 transition-colors ${
                        isCritical
                          ? "bg-red-50 hover:bg-red-100"
                          : "hover:bg-[color:var(--color-brand-bg)]"
                      }`}
                    >
                      <p
                        className={`font-semibold ${
                          isCritical
                            ? "text-red-900"
                            : "text-[color:var(--color-brand-navy)]"
                        }`}
                      >
                        {isCritical ? "🚨 " : ""}
                        {item.title}
                      </p>
                      <p
                        className={`text-xs ${
                          isCritical
                            ? "text-red-800"
                            : "text-[color:var(--color-brand-text-soft)]"
                        }`}
                      >
                        {item.subtitle}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
}
