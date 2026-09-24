"use client";

import * as React from "react";
import { manilaDateTime } from "@/lib/dates/manila";
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
import { STAFF_BOOKING_NOTES_MAX, type StaffBookingInput } from "@/lib/validations/staff-booking";
import { BOOKING_BRANCH_LABEL } from "@/lib/appointments/labels";
import type { BookingConflict } from "@/lib/appointments/timing";
import { STAFF_SELECTABLE_SOURCES, APPOINTMENT_SOURCE_LABEL } from "@/lib/appointments/source";
import {
  PRE_REGISTERED_LABEL_SHORT,
  PRE_REGISTERED_BADGE_CLASS,
} from "@/lib/patients/labels";
import {
  createStaffAppointmentAction,
  searchPatientsAction,
  getPatientUpcomingAppointmentsAction,
  type PatientSearchRow,
  type UpcomingApptRow,
} from "./new-appointment-actions";
import { checkPatientDuplicatesAction, type PublicCandidate } from "@/lib/patients/check-duplicates-action";

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

const BRANCH_LABELS = BOOKING_BRANCH_LABEL;

type PatientMode = "existing" | "new" | "walk_in";

const INPUT_CLS = "rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm";

// Opens the sheet pre-filled from the Website Messages inbox's "Book
// appointment" button (appointments/page.tsx's `?from_message=`). Sent back
// to the server as `contact_message_id` so createStaffAppointmentAction can
// link the resulting booking to the message.
export interface NewAppointmentPrefill {
  contactMessageId: string;
  senderName: string;
  walkInName: string;
  walkInPhone: string;
  source: "website_message";
  notes: string;
}

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
  onlineBookingPaused = false,
  prefill,
}: {
  services: ServiceOption[];
  physicians: PhysicianOption[];
  selfBookUrl: string;
  // While an admin has paused online booking the self-book QR would only lead
  // to the "contact reception" notice, so the sheet says so instead of
  // offering it (booking_settings, 0153).
  onlineBookingPaused?: boolean;
  // Set only by /staff/appointments?from_message=<id> — opens the sheet
  // automatically, pre-filled for a website message. Absent on every other
  // render, and the component's own default state below is unchanged in
  // that case.
  prefill?: NewAppointmentPrefill;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(() => Boolean(prefill));
  const [pending, startTransition] = React.useTransition();

  // Patient
  const [mode, setMode] = React.useState<PatientMode>(() => (prefill ? "walk_in" : "existing"));
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
  const [walkIn, setWalkIn] = React.useState(() => ({
    walk_in_name: prefill?.walkInName ?? "",
    walk_in_phone: prefill?.walkInPhone ?? "",
  }));

  // How the patient reached us (0154) — required. Preset from a message
  // booking, otherwise blank until reception picks one.
  const [source, setSource] = React.useState<string>(() => prefill?.source ?? "");
  const [notes, setNotes] = React.useState<string>(() => prefill?.notes ?? "");

  // The Website Messages inbox link this booking should close the loop on —
  // undefined for every ordinary booking. Cleared (not re-armed) by
  // resetAll(), so cancelling or re-submitting starts the next booking blank
  // rather than silently re-linking the same message.
  const [contactMessageId, setContactMessageId] = React.useState<string | undefined>(
    () => prefill?.contactMessageId,
  );
  const [isFromMessage, setIsFromMessage] = React.useState(() => Boolean(prefill));
  const fromMessageSenderName = prefill?.senderName ?? null;
  const fromMessageMissingPhone = Boolean(prefill) && !prefill?.walkInPhone;

  // Booking
  const [branch, setBranch] = React.useState<BookingBranch>("diagnostic_package");
  const [serviceIds, setServiceIds] = React.useState<string[]>([]);
  const [serviceId, setServiceId] = React.useState(""); // doctor consultation
  const [physicianId, setPhysicianId] = React.useState("");
  const [scheduledAtLocal, setScheduledAtLocal] = React.useState("");
  const [sendConfirmation, setSendConfirmation] = React.useState(true);
  const [showQr, setShowQr] = React.useState(false);

  // Near-duplicate advisory for "New patient" mode.
  const [dupCandidates, setDupCandidates] = React.useState<PublicCandidate[]>([]);

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

  // Debounced near-duplicate check for "New patient" mode. All setState runs
  // inside the debounced callback (never synchronously in the effect body).
  React.useEffect(() => {
    const t = setTimeout(async () => {
      if (
        mode !== "new" ||
        !newP.last_name.trim() ||
        (!newP.email && !newP.phone && !newP.birthdate)
      ) {
        setDupCandidates([]);
        return;
      }
      const res = await checkPatientDuplicatesAction({
        first_name: newP.first_name,
        last_name: newP.last_name,
        birthdate: newP.birthdate || null,
        email: newP.email || null,
        phone: newP.phone || null,
      });
      if (res.ok) setDupCandidates(res.candidates);
    }, 400);
    return () => clearTimeout(t);
  }, [mode, newP.first_name, newP.last_name, newP.birthdate, newP.email, newP.phone]);

  function resetAll() {
    setMode("existing");
    setQuery("");
    setResults([]);
    setSelected(null);
    setUpcoming([]);
    setNewP({ first_name: "", last_name: "", middle_name: "", birthdate: "", sex: "", phone: "", email: "", address: "" });
    setWalkIn({ walk_in_name: "", walk_in_phone: "" });
    setSource("");
    setNotes("");
    setContactMessageId(undefined);
    setIsFromMessage(false);
    setBranch("diagnostic_package");
    setServiceIds([]);
    setServiceId("");
    setPhysicianId("");
    setScheduledAtLocal("");
    setSendConfirmation(true);
    setShowQr(false);
    setDupCandidates([]);
    setConflicts([]);
    setError(null);
  }

  function pickPatient(p: PatientSearchRow) {
    setSelected(p);
    setResults([]);
    setQuery(`${p.last_name}, ${p.first_name} · ${p.drm_id}`);
    getPatientUpcomingAppointmentsAction(p.id).then((r) => setUpcoming(r.ok ? r.data : []));
  }

  /** Switch to "Existing patient" mode and pre-select the given candidate.
   *  Resolves the full PatientSearchRow via searchPatientsAction so pickPatient
   *  can populate the query label and fetch upcoming appointments normally.
   *  Searches by DRM-ID (a searchable field) — NOT the UUID, which patient
   *  search does not match on — then disambiguates to the exact row by id. */
  function handleUseExistingPatient(candidate: PublicCandidate) {
    searchPatientsAction(candidate.drm_id).then((r) => {
      if (!r.ok) return;
      const match = r.data.find((p) => p.id === candidate.id);
      if (!match) return;
      setMode("existing");
      setDupCandidates([]);
      setNewP({ first_name: "", last_name: "", middle_name: "", birthdate: "", sex: "", phone: "", email: "", address: "" });
      pickPatient(match);
    });
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
    // Soft-confirm when an exact-dup advisory is showing — the user can still proceed.
    if (mode === "new") {
      const hasExact = dupCandidates.some((c) => c.tier === "exact_dup");
      if (hasExact && !window.confirm("This looks like an exact match for an existing patient. Create a SEPARATE record anyway?")) {
        return;
      }
    }
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
      notes: notes.trim() ? notes.trim() : null,
      send_confirmation: sendConfirmation,
      override,
      source,
      contact_message_id: contactMessageId,
    };

    // Booking from a message navigates to a plain URL afterward, dropping
    // ?from_message= — otherwise a page refresh (e.g. the realtime
    // subscription below) would re-derive the same prefill and the operator
    // would see the sheet's initial state again next time they open it.
    const wasFromMessage = Boolean(contactMessageId);

    startTransition(async () => {
      const result = await createStaffAppointmentAction(input);
      if (result.ok) {
        toast.success(
          wasFromMessage ? "Appointment created and the message marked booked." : "Appointment created.",
        );
        setOpen(false);
        resetAll();
        if (wasFromMessage) {
          router.push("/staff/appointments");
        } else {
          router.refresh();
        }
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
          {isFromMessage && fromMessageSenderName ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              <p className="font-semibold">
                Booking for a website message from {fromMessageSenderName}.
              </p>
              {fromMessageMissingPhone ? (
                <p className="mt-1 text-xs">
                  This message had no phone number on file — add one below before saving.
                </p>
              ) : null}
            </div>
          ) : null}

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
                            {p.pre_registered ? (
                              <span
                                className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${PRE_REGISTERED_BADGE_CLASS}`}
                              >
                                {PRE_REGISTERED_LABEL_SHORT}
                              </span>
                            ) : null}
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
                            ? manilaDateTime(u.scheduled_at)
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
              <>
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
                {dupCandidates.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                    <p className="mb-2 font-semibold text-amber-900">
                      Possible existing patient{dupCandidates.length > 1 ? "s" : ""}:
                    </p>
                    <ul className="space-y-2">
                      {dupCandidates.map((c) => (
                        <li key={c.id} className="flex items-center justify-between gap-2">
                          <span className="text-amber-900">
                            {c.first_name} {c.last_name} · {c.drm_id} · {c.birthdate ?? "—"}
                            {c.tier === "exact_dup" && (
                              <span className="ml-1 font-bold text-red-700">exact match</span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleUseExistingPatient(c)}
                            className="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                          >
                            Use this patient
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            {mode === "walk_in" && (
              <div className="flex flex-col gap-2">
                <input value={walkIn.walk_in_name} onChange={(e) => setWalkIn({ ...walkIn, walk_in_name: e.target.value })} placeholder="Walk-in name" className={INPUT_CLS} />
                <input value={walkIn.walk_in_phone} onChange={(e) => setWalkIn({ ...walkIn, walk_in_phone: e.target.value })} placeholder="Walk-in phone" className={INPUT_CLS} />
                <p className="text-xs text-muted-foreground">
                  No patient record is created yet. Once they arrive, use “Attach patient” on this row in the appointments list to link one — “+ Start visit” appears right after.
                </p>
              </div>
            )}
          </section>

          {/* 1.5. How did they reach us — required (0154). */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">How did they reach us?</p>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={INPUT_CLS}
              aria-label="How did they reach us?"
            >
              <option value="">Choose…</option>
              {STAFF_SELECTABLE_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {APPOINTMENT_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
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

          {/* 5. Notes — optional, always available (not just for message bookings). */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Notes (optional)</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={STAFF_BOOKING_NOTES_MAX}
              placeholder="Anything reception or the doctor should know"
              className={`${INPUT_CLS} resize-none`}
            />
          </section>

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

          {/* Self-book QR — hidden while online booking is paused */}
          {onlineBookingPaused ? (
            <p className="text-xs text-muted-foreground">
              Online self-booking is paused, so there is no self-book QR right now — book the patient here.
            </p>
          ) : (
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
          )}
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
