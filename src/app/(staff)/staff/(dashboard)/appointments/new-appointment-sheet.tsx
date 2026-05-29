"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { QrCode } from "@/components/ui/qr-code";
import { KINDS_PER_BRANCH, BOOKING_BRANCHES, type BookingBranch } from "@/lib/validations/booking";
import type { StaffBookingInput } from "@/lib/validations/staff-booking";
import type { BookingConflict } from "@/lib/appointments/timing";
import {
  createStaffAppointmentAction,
  searchPatientsAction,
  getPatientUpcomingAppointmentsAction,
  type PatientSearchRow,
  type UpcomingApptRow,
} from "./new-appointment-actions";

export interface ServiceOption {
  id: string;
  name: string;
  kind: string;
  requires_time_slot: boolean;
}
export interface PhysicianOption {
  id: string;
  full_name: string;
}

const BRANCH_LABELS: Record<BookingBranch, string> = {
  diagnostic_package: "Diagnostic package",
  lab_request: "Lab request",
  doctor_appointment: "Doctor appointment",
  home_service: "Home service",
};

type PatientMode = "existing" | "new" | "walk_in";

const INPUT_CLS = "rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm";

// datetime-local has no zone; staff + clinic are Asia/Manila (UTC+8, no DST).
function toManilaIso(localValue: string): string | null {
  if (!localValue) return null;
  const d = new Date(`${localValue}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function NewAppointmentSheet({
  services,
  physicians,
  selfBookUrl,
}: {
  services: ServiceOption[];
  physicians: PhysicianOption[];
  selfBookUrl: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // Patient
  const [mode, setMode] = React.useState<PatientMode>("existing");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PatientSearchRow[]>([]);
  const [selected, setSelected] = React.useState<PatientSearchRow | null>(null);
  const [upcoming, setUpcoming] = React.useState<UpcomingApptRow[]>([]);
  const [newP, setNewP] = React.useState({
    first_name: "",
    last_name: "",
    middle_name: "",
    birthdate: "",
    sex: "" as "" | "male" | "female",
    phone: "",
    email: "",
    address: "",
  });
  const [walkIn, setWalkIn] = React.useState({ walk_in_name: "", walk_in_phone: "" });

  // Booking
  const [branch, setBranch] = React.useState<BookingBranch>("diagnostic_package");
  const [serviceIds, setServiceIds] = React.useState<string[]>([]);
  const [serviceId, setServiceId] = React.useState(""); // doctor consultation
  const [physicianId, setPhysicianId] = React.useState("");
  const [scheduledAtLocal, setScheduledAtLocal] = React.useState("");
  const [sendConfirmation, setSendConfirmation] = React.useState(true);
  const [showQr, setShowQr] = React.useState(false);

  const [conflicts, setConflicts] = React.useState<BookingConflict[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const allowedKinds = KINDS_PER_BRANCH[branch];
  const branchServices = services.filter((s) => allowedKinds.includes(s.kind));
  const takesTime = branch === "lab_request" || branch === "doctor_appointment";

  // Debounced patient search.
  React.useEffect(() => {
    if (mode !== "existing") return;
    const term = query.trim();
    // Don't setState synchronously in the effect body (react-hooks/set-state-in-effect);
    // the results list is gated in render on query length + selection instead.
    if (selected || term.length < 2) return;
    const handle = setTimeout(() => {
      searchPatientsAction(term).then((r) => {
        if (r.ok) setResults(r.data);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query, mode, selected]);

  function resetAll() {
    setMode("existing");
    setQuery("");
    setResults([]);
    setSelected(null);
    setUpcoming([]);
    setNewP({ first_name: "", last_name: "", middle_name: "", birthdate: "", sex: "", phone: "", email: "", address: "" });
    setWalkIn({ walk_in_name: "", walk_in_phone: "" });
    setBranch("diagnostic_package");
    setServiceIds([]);
    setServiceId("");
    setPhysicianId("");
    setScheduledAtLocal("");
    setSendConfirmation(true);
    setShowQr(false);
    setConflicts([]);
    setError(null);
  }

  function pickPatient(p: PatientSearchRow) {
    setSelected(p);
    setResults([]);
    setQuery(`${p.last_name}, ${p.first_name} · ${p.drm_id}`);
    getPatientUpcomingAppointmentsAction(p.id).then((r) => setUpcoming(r.ok ? r.data : []));
  }

  function buildPatient(): StaffBookingInput["patient"] | { error: string } {
    if (mode === "existing") {
      if (!selected) return { error: "Search and pick a patient first." };
      return { mode: "existing", patient_id: selected.id };
    }
    if (mode === "new") {
      return {
        mode: "new",
        first_name: newP.first_name,
        last_name: newP.last_name,
        middle_name: newP.middle_name,
        birthdate: newP.birthdate,
        sex: newP.sex,
        email: newP.email,
        phone: newP.phone,
        address: newP.address,
      };
    }
    return { mode: "walk_in", walk_in_name: walkIn.walk_in_name, walk_in_phone: walkIn.walk_in_phone };
  }

  function submit(override: boolean) {
    setError(null);
    const patient = buildPatient();
    if ("error" in patient) {
      setError(patient.error);
      return;
    }
    const input: StaffBookingInput = {
      patient,
      branch,
      service_id: branch === "doctor_appointment" ? serviceId : undefined,
      service_ids: branch === "doctor_appointment" ? undefined : serviceIds,
      physician_id: branch === "doctor_appointment" ? physicianId : undefined,
      scheduled_at: takesTime ? toManilaIso(scheduledAtLocal) : null,
      notes: null,
      send_confirmation: sendConfirmation,
      override,
    };

    startTransition(async () => {
      const result = await createStaffAppointmentAction(input);
      if (result.ok) {
        toast.success("Appointment created.");
        setOpen(false);
        resetAll();
        router.refresh();
        return;
      }
      if ("code" in result && result.code === "conflict") {
        setConflicts(result.data.conflicts);
        setError(null);
        return;
      }
      setConflicts([]);
      setError(result.error);
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetAll();
      }}
    >
      <SheetTrigger
        render={<Button className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]" />}
      >
        + New appointment
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New appointment</SheetTitle>
          <SheetDescription>
            Phone-in or re-entered bookings. For a walk-in who is ready now, use Create visit instead.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5">
          {/* 1. Patient */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Patient</p>
            <div className="flex gap-1">
              {(["existing", "new", "walk_in"] as PatientMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setSelected(null);
                    setUpcoming([]);
                    setQuery("");
                    setResults([]);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                    mode === m ? "bg-[color:var(--color-brand-navy)] text-white" : "bg-muted text-foreground"
                  }`}
                >
                  {m === "existing" ? "Existing" : m === "new" ? "New" : "Walk-in"}
                </button>
              ))}
            </div>

            {mode === "existing" && (
              <div className="flex flex-col gap-1">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelected(null);
                  }}
                  placeholder="Search DRM-ID, name, phone, email…"
                  className={INPUT_CLS}
                />
                {!selected && query.trim().length >= 2 && results.length > 0 && (
                  <ul className="max-h-44 overflow-y-auto rounded-md border border-[color:var(--color-brand-bg-mid)]">
                    {results.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => pickPatient(p)}
                          className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="font-semibold">
                            {p.last_name}, {p.first_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {p.drm_id} · {p.phone ?? p.email ?? "—"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {selected && upcoming.length > 0 && (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                    <p className="font-semibold">Upcoming for this patient:</p>
                    <ul className="mt-1 list-disc pl-4">
                      {upcoming.map((u) => (
                        <li key={u.id}>
                          {u.scheduled_at
                            ? new Date(u.scheduled_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
                            : "Pending callback"}
                          {u.service_name ? ` · ${u.service_name}` : ""}
                          {u.physician_name ? ` · ${u.physician_name}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {mode === "new" && (
              <div className="grid grid-cols-2 gap-2">
                <input value={newP.first_name} onChange={(e) => setNewP({ ...newP, first_name: e.target.value })} placeholder="First name" className={INPUT_CLS} />
                <input value={newP.last_name} onChange={(e) => setNewP({ ...newP, last_name: e.target.value })} placeholder="Last name" className={INPUT_CLS} />
                <input value={newP.middle_name} onChange={(e) => setNewP({ ...newP, middle_name: e.target.value })} placeholder="Middle name (optional)" className={INPUT_CLS} />
                <input type="date" value={newP.birthdate} onChange={(e) => setNewP({ ...newP, birthdate: e.target.value })} className={INPUT_CLS} />
                <select value={newP.sex} onChange={(e) => setNewP({ ...newP, sex: e.target.value as "" | "male" | "female" })} className={INPUT_CLS}>
                  <option value="">Sex (optional)</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
                <input value={newP.phone} onChange={(e) => setNewP({ ...newP, phone: e.target.value })} placeholder="Phone" className={INPUT_CLS} />
                <input value={newP.email} onChange={(e) => setNewP({ ...newP, email: e.target.value })} placeholder="Email (required)" className={`col-span-2 ${INPUT_CLS}`} />
                <input value={newP.address} onChange={(e) => setNewP({ ...newP, address: e.target.value })} placeholder="Address (optional)" className={`col-span-2 ${INPUT_CLS}`} />
              </div>
            )}

            {mode === "walk_in" && (
              <div className="flex flex-col gap-2">
                <input value={walkIn.walk_in_name} onChange={(e) => setWalkIn({ ...walkIn, walk_in_name: e.target.value })} placeholder="Walk-in name" className={INPUT_CLS} />
                <input value={walkIn.walk_in_phone} onChange={(e) => setWalkIn({ ...walkIn, walk_in_phone: e.target.value })} placeholder="Walk-in phone" className={INPUT_CLS} />
                <p className="text-xs text-muted-foreground">
                  No patient record is created. The “+ Start visit” button only appears once reception registers them on arrival.
                </p>
              </div>
            )}
          </section>

          {/* 2. Booking type */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Booking type</p>
            <select
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value as BookingBranch);
                setServiceIds([]);
                setServiceId("");
                setPhysicianId("");
                setConflicts([]);
              }}
              className={INPUT_CLS}
            >
              {BOOKING_BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {BRANCH_LABELS[b]}
                </option>
              ))}
            </select>
          </section>

          {/* 3. Services / Doctor */}
          <section className="flex flex-col gap-2">
            {branch === "doctor_appointment" ? (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Consultation &amp; doctor</p>
                <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={INPUT_CLS}>
                  <option value="">Pick a consultation…</option>
                  {branchServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select value={physicianId} onChange={(e) => setPhysicianId(e.target.value)} className={INPUT_CLS}>
                  <option value="">Pick a physician…</option>
                  {physicians.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Service(s)</p>
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-[color:var(--color-brand-bg-mid)] p-2">
                  {branchServices.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">No services for this type.</p>
                  ) : (
                    branchServices.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={serviceIds.includes(s.id)}
                          onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((id) => id !== s.id))}
                        />
                        {s.name}
                      </label>
                    ))
                  )}
                </div>
              </>
            )}
          </section>

          {/* 4. When */}
          {takesTime && (
            <section className="flex flex-col gap-2">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">When (optional)</p>
              <input type="datetime-local" value={scheduledAtLocal} onChange={(e) => setScheduledAtLocal(e.target.value)} className={INPUT_CLS} />
              <p className="text-xs text-muted-foreground">30-minute slots, Mon–Sat 8:00 AM–4:30 PM. Same-day is allowed.</p>
            </section>
          )}

          {/* Conflicts (overridable) */}
          {conflicts.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">⚠ Scheduling conflict</p>
              <ul className="mt-1 list-disc pl-4">
                {conflicts.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
              <Button type="button" size="sm" disabled={pending} onClick={() => submit(true)} className="mt-2 bg-amber-600 text-white hover:bg-amber-700">
                {pending ? "…" : "Book anyway"}
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Self-book QR */}
          <div>
            <button type="button" onClick={() => setShowQr((v) => !v)} className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline">
              {showQr ? "Hide self-book QR" : "Patient prefers to book themselves? Show QR"}
            </button>
            {showQr && (
              <div className="mt-2 flex flex-col items-center gap-1">
                <QrCode value={selfBookUrl} size={150} />
                <span className="font-mono text-[10px] break-all text-muted-foreground">{selfBookUrl}</span>
              </div>
            )}
          </div>
        </div>

        <SheetFooter>
          <label className="mr-auto flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendConfirmation} onChange={(e) => setSendConfirmation(e.target.checked)} />
            Send confirmation (SMS + email)
          </label>
          <SheetClose render={<Button variant="outline" disabled={pending} />}>Cancel</SheetClose>
          <Button type="button" disabled={pending} onClick={() => submit(false)} className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]">
            {pending ? "Creating…" : "Create"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
