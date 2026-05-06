"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhp } from "@/lib/marketing/format";
import {
  SlotPicker,
  type ClosureLite,
} from "@/components/marketing/slot-picker";
import type {
  AvailabilityBlock,
  AvailabilityOverride,
} from "@/lib/physicians/availability";
import {
  lookupPatientAction,
  submitBookingAction,
  type BookingResult,
  type LookupPatientResult,
} from "./actions";

export type ServiceKind =
  | "lab_test"
  | "lab_package"
  | "doctor_consultation";

export interface ServiceLite {
  id: string;
  code: string;
  name: string;
  kind: ServiceKind;
  description: string | null;
  price_php: number;
  fasting_required: boolean;
  requires_time_slot: boolean;
  specialty_code: string | null;
}

export interface SpecialtyOption {
  code: string;
  label: string;
}

export interface BookablePhysician {
  id: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  photo_url: string;
  specialty_codes: string[];
  blocks: AvailabilityBlock[];
  overrides: AvailabilityOverride[];
}

export interface ByAppointmentPhysician {
  id: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  photo_url: string;
  specialty_codes: string[];
}

type Branch =
  | "diagnostic_package"
  | "lab_request"
  | "doctor_appointment"
  | "home_service";

export interface PrefilledPatient {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
}

interface Props {
  services: ServiceLite[];
  closures: ClosureLite[];
  startDate: string;
  specialties: SpecialtyOption[];
  physicians: BookablePhysician[];
  byAppointmentPhysicians: ByAppointmentPhysician[];
  // When set, the form skips the patient-mode toggle + lookup and
  // submits the booking against this patient. Used by /portal/book —
  // the patient is already authenticated via session, so the server
  // re-derives patient_id from the session cookie regardless of what
  // the form posts.
  prefilledPatient?: PrefilledPatient;
}

const KINDS_PER_BRANCH: Record<Branch, ReadonlyArray<ServiceKind>> = {
  diagnostic_package: ["lab_package"],
  lab_request: ["lab_test"],
  doctor_appointment: ["doctor_consultation"],
  home_service: ["lab_test", "lab_package"],
};

const BRANCH_LABELS: Record<Branch, string> = {
  diagnostic_package: "Diagnostic Package",
  lab_request: "Laboratory Request",
  doctor_appointment: "Doctor Appointment",
  home_service: "Home Service",
};

const BRANCH_BLURBS: Record<Branch, string> = {
  diagnostic_package:
    "Pre-built bundles like CBC + Lipid + FBS. Reception will call to confirm a date that works for you.",
  lab_request:
    "Individual lab tests, X-ray, ECG, and ultrasounds. Pick one or more — only ultrasound needs a specific time slot.",
  doctor_appointment:
    "Consultation with one of our specialists. Pick a specialty, then a doctor, then a slot.",
  home_service:
    "We come to your home for the test. Subject to availability — reception will call to confirm.",
};

export function BookingForm({
  services,
  closures,
  startDate,
  specialties,
  physicians,
  byAppointmentPhysicians,
  prefilledPatient,
}: Props) {
  const isPortalContext = prefilledPatient !== undefined;
  const [branch, setBranch] = useState<Branch>("lab_request");
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(
    new Set(),
  );
  const [singleServiceId, setSingleServiceId] = useState<string>("");
  const [specialtyCode, setSpecialtyCode] = useState<string>("");
  const [physicianId, setPhysicianId] = useState<string>("");
  const [serviceQuery, setServiceQuery] = useState("");
  const [patientMode, setPatientMode] = useState<"new" | "existing">(
    isPortalContext ? "existing" : "new",
  );
  const [resolvedPatient, setResolvedPatient] = useState<{
    id: string;
    drm_id: string;
    first_name: string;
    last_name: string;
  } | null>(prefilledPatient ?? null);
  const [lookupState, lookupAction, lookupPending] = useActionState<
    LookupPatientResult | null,
    FormData
  >(async (_prev, formData) => {
    const result = await lookupPatientAction(_prev, formData);
    if (result.ok) {
      setResolvedPatient(result.patient);
    }
    return result;
  }, null);
  const [state, formAction, pending] = useActionState<
    BookingResult | null,
    FormData
  >(submitBookingAction, null);

  const filteredServices = useMemo(() => {
    const allowed = new Set<ServiceKind>(KINDS_PER_BRANCH[branch]);
    const q = serviceQuery.trim().toLowerCase();
    return services.filter((s) => {
      if (!allowed.has(s.kind)) return false;
      if (!q) return true;
      return `${s.name} ${s.code}`.toLowerCase().includes(q);
    });
  }, [services, branch, serviceQuery]);

  const allConsultations = useMemo(
    () => services.filter((s) => s.kind === "doctor_consultation"),
    [services],
  );

  // Each specialty (except `general`) maps to exactly one consultation
  // service via services.specialty_code. For non-general picks we hide the
  // dropdown and auto-select the matching consultation; for `general` we
  // show all consultations so the patient can pick.
  const consultationServices = useMemo(() => {
    if (!specialtyCode || specialtyCode === "general") return allConsultations;
    return allConsultations.filter((s) => s.specialty_code === specialtyCode);
  }, [allConsultations, specialtyCode]);

  const isSpecialtyAutoConsult =
    branch === "doctor_appointment" &&
    specialtyCode !== "" &&
    specialtyCode !== "general" &&
    consultationServices.length === 1;
  const autoConsultService = isSpecialtyAutoConsult
    ? consultationServices[0]!
    : null;

  const physiciansForSpecialty = useMemo(() => {
    if (!specialtyCode) return [];
    return physicians.filter((p) =>
      p.specialty_codes.includes(specialtyCode),
    );
  }, [physicians, specialtyCode]);

  const byAppointmentForSpecialty = useMemo(() => {
    if (!specialtyCode) return [];
    return byAppointmentPhysicians.filter((p) =>
      p.specialty_codes.includes(specialtyCode),
    );
  }, [byAppointmentPhysicians, specialtyCode]);

  const selectedPhysician = physicianId
    ? physicians.find((p) => p.id === physicianId) ?? null
    : null;
  const selectedByAppointment = physicianId
    ? byAppointmentPhysicians.find((p) => p.id === physicianId) ?? null
    : null;
  const isByAppointment = selectedByAppointment !== null;

  // Fasting warning is only meaningful when a fasting-required service is
  // actually picked. Showing it on every lab/package booking dilutes the
  // signal and confuses patients picking, e.g., just CBC + UA.
  const showFastingDisclaimer =
    (branch === "diagnostic_package" || branch === "lab_request") &&
    Array.from(selectedServiceIds).some((id) => {
      const s = services.find((x) => x.id === id);
      return s?.fasting_required;
    });

  const labRequiresSlot =
    branch === "lab_request" &&
    Array.from(selectedServiceIds).some((id) => {
      const s = services.find((x) => x.id === id);
      return s?.requires_time_slot;
    });
  const doctorRequiresSlot =
    branch === "doctor_appointment" && selectedPhysician !== null;
  const showSlotPicker = labRequiresSlot || doctorRequiresSlot;

  const physicianAvailability = selectedPhysician
    ? {
        blocks: selectedPhysician.blocks,
        overrides: selectedPhysician.overrides,
      }
    : null;

  if (state?.ok && state.drm_id) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-8">
        <h3 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          {state.pending_callback
            ? "Request received."
            : "Booking confirmed."}
        </h3>
        <p className="mt-3 text-base text-[color:var(--color-brand-text-mid)]">
          {state.service_summary}
          {state.scheduled_at
            ? ` · ${new Date(state.scheduled_at).toLocaleString("en-PH", {
                dateStyle: "long",
                timeStyle: "short",
                timeZone: "Asia/Manila",
              })}`
            : ""}
        </p>
        {state.pending_callback ? (
          <p className="mt-3 text-sm text-[color:var(--color-brand-text-mid)]">
            We&apos;ll call you within one working day to confirm a time
            and any other details.
          </p>
        ) : null}
        {isPortalContext ? (
          <p className="mt-5 text-sm text-[color:var(--color-brand-text-mid)]">
            A confirmation has been sent to the contact info on your file.
            <Link
              href="/portal"
              className="ml-2 font-bold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Back to portal →
            </Link>
          </p>
        ) : (
          <div className="mt-5 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Your DRM-ID
            </p>
            <p className="mt-1 font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              {state.drm_id}
            </p>
            <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
              Save this. After your visit, your Secure PIN is printed on the
              receipt — both are required to access results online.
            </p>
          </div>
        )}
      </div>
    );
  }

  const showLookupForm = patientMode === "existing" && !resolvedPatient;
  const isExistingMode = patientMode === "existing" && resolvedPatient !== null;

  return (
    <div className="grid gap-6">
      {isPortalContext ? null : (
        <fieldset className="grid gap-3">
          <legend className="text-sm font-bold text-[color:var(--color-brand-navy)]">
            Are you an existing patient?
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <PatientModeOption
              checked={patientMode === "new"}
              onChange={() => {
                setPatientMode("new");
                setResolvedPatient(null);
              }}
              title="No, I'm new"
              blurb="First time at DRMed. We'll register you and assign a DRM-ID."
            />
            <PatientModeOption
              checked={patientMode === "existing"}
              onChange={() => setPatientMode("existing")}
              title="Yes, I have a DRM-ID"
              blurb="From a previous receipt. Skip retyping your details."
            />
          </div>
        </fieldset>
      )}

      {showLookupForm ? (
        <form
          action={lookupAction}
          className="grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4"
        >
          <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
            Find your record
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="DRM-ID"
              name="drm_id"
              required
              placeholder="DRM-0001"
              maxLength={20}
            />
            <Field
              label="Last name on file"
              name="last_name"
              required
              maxLength={80}
            />
          </div>
          {lookupState && !lookupState.ok ? (
            <p className="text-sm text-red-600" role="alert">
              {lookupState.error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={lookupPending}
              className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
            >
              {lookupPending ? "Looking up…" : "Look up"}
            </Button>
          </div>
        </form>
      ) : null}

      {isExistingMode && resolvedPatient ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Booking as
            </p>
            <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
              {resolvedPatient.first_name} {resolvedPatient.last_name}
            </p>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              {resolvedPatient.drm_id}
            </p>
          </div>
          {isPortalContext ? null : (
            <button
              type="button"
              onClick={() => setResolvedPatient(null)}
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Use a different patient
            </button>
          )}
        </div>
      ) : null}

      {showLookupForm ? null : (
    <form action={formAction} className="grid gap-6">
      <input type="hidden" name="branch" value={branch} />
      {isPortalContext ? <input type="hidden" name="source" value="portal" /> : null}
      {isExistingMode && resolvedPatient ? (
        <input type="hidden" name="patient_id" value={resolvedPatient.id} />
      ) : null}

      {/* Honeypot */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset className="grid gap-3">
        <legend className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          What are you booking?
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(KINDS_PER_BRANCH) as Branch[]).map((b) => (
            <BranchOption
              key={b}
              checked={branch === b}
              onChange={() => {
                setBranch(b);
                setSelectedServiceIds(new Set());
                setSingleServiceId("");
                setSpecialtyCode("");
                setPhysicianId("");
              }}
              title={BRANCH_LABELS[b]}
              blurb={BRANCH_BLURBS[b]}
            />
          ))}
        </div>
      </fieldset>

      {branch === "home_service" ? (
        <Disclaimer tone="info">
          Home service is subject to availability. Reception will contact
          you directly to confirm the requested appointment.
        </Disclaimer>
      ) : null}
      {showFastingDisclaimer ? (
        <Disclaimer tone="warning">
          Some tests need to be taken while fasted (e.g. FBS, Lipid Profile,
          OGTT). Please review your selections — fasting-required services
          are flagged in the list. When in doubt, call reception before
          your visit.
        </Disclaimer>
      ) : null}

      {isExistingMode ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" name="first_name" required maxLength={80} />
            <Field label="Last name" name="last_name" required maxLength={80} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Middle name (optional)"
              name="middle_name"
              maxLength={80}
            />
            <Field label="Birthdate" name="birthdate" type="date" required />
            <div className="grid gap-1.5">
              <Label htmlFor="sex">Sex</Label>
              <select
                id="sex"
                name="sex"
                className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              >
                <option value="">—</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              name="phone"
              type="tel"
              required
              placeholder="+639XXXXXXXXX or 09XX..."
              maxLength={40}
            />
            <Field
              label="Email"
              name="email"
              type="email"
              required
              maxLength={160}
            />
          </div>
          <Field label="Address (optional)" name="address" maxLength={200} />
        </>
      )}

      {branch === "doctor_appointment" ? (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="specialty">Specialty</Label>
            <select
              id="specialty"
              value={specialtyCode}
              onChange={(e) => {
                setSpecialtyCode(e.target.value);
                setPhysicianId("");
                setSingleServiceId("");
              }}
              required
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">— Pick a specialty —</option>
              {specialties.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {specialtyCode ? (
            <div className="grid gap-1.5">
              <Label htmlFor="physician_id">Physician</Label>
              <input type="hidden" name="physician_id" value={physicianId} />
              <select
                id="physician_id"
                value={physicianId}
                onChange={(e) => setPhysicianId(e.target.value)}
                required
                className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              >
                <option value="">— Pick a physician —</option>
                {physiciansForSpecialty.length > 0 ? (
                  <optgroup label="Available with online booking">
                    {physiciansForSpecialty.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name} · {p.specialty}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {byAppointmentForSpecialty.length > 0 ? (
                  <optgroup label="By appointment — we'll call to confirm">
                    {byAppointmentForSpecialty.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name} · {p.specialty}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              {physiciansForSpecialty.length === 0 &&
              byAppointmentForSpecialty.length === 0 ? (
                <p className="text-xs text-amber-700">
                  No physicians match this specialty yet.
                </p>
              ) : null}
            </div>
          ) : null}

          {physicianId ? (
            <>
              {autoConsultService ? (
                <div className="grid gap-1.5">
                  <Label>Consultation type</Label>
                  <input
                    type="hidden"
                    name="service_id"
                    value={autoConsultService.id}
                  />
                  <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-3 py-2 text-sm">
                    <span className="font-semibold text-[color:var(--color-brand-navy)]">
                      {autoConsultService.name}
                    </span>{" "}
                    <span className="text-[color:var(--color-brand-text-soft)]">
                      ({formatPhp(autoConsultService.price_php)})
                    </span>
                  </div>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="service_id">Consultation type</Label>
                  <select
                    id="service_id"
                    name="service_id"
                    value={singleServiceId}
                    onChange={(e) => setSingleServiceId(e.target.value)}
                    required
                    className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                  >
                    <option value="">— Pick a consultation —</option>
                    {consultationServices.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({formatPhp(s.price_php)})
                      </option>
                    ))}
                  </select>
                  {consultationServices.length === 0 ? (
                    <p className="text-xs text-amber-700">
                      No consultations are configured for this specialty
                      yet. Please call reception.
                    </p>
                  ) : null}
                </div>
              )}

              {isByAppointment ? (
                <Disclaimer tone="info">
                  This physician is by appointment only — reception will
                  call you to confirm a date and time.
                </Disclaimer>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <ServiceMultiPicker
          query={serviceQuery}
          onQueryChange={setServiceQuery}
          services={filteredServices}
          selectedIds={selectedServiceIds}
          onToggle={(id) => {
            setSelectedServiceIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
        />
      )}

      {showSlotPicker ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4">
          <SlotPicker
            startDate={startDate}
            closures={closures}
            availability={physicianAvailability}
            required={false}
          />
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          placeholder="HMO, fasting needed, mobility, etc."
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      <div className="grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm">
        {isPortalContext ? null : (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="service_agreement"
            value="on"
            required
            className="mt-1"
          />
          <span>
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              Service agreement (required).
            </span>{" "}
            I consent to drmed.ph processing my contact details to fulfil
            this booking under the Philippine Data Privacy Act (RA 10173).
            Lab results are released only after payment. See the{" "}
            <Link
              href="/privacy"
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Privacy Notice
            </Link>{" "}
            for details.
          </span>
        </label>
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="marketing_consent"
            value="on"
            className="mt-1"
          />
          <span>
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              Newsletter (optional).
            </span>{" "}
            Send me occasional updates on new tests, promos, and clinic
            announcements. One-click unsubscribe in every email.
          </span>
        </label>
      </div>

      {branch !== "doctor_appointment"
        ? Array.from(selectedServiceIds).map((id) => (
            <input key={id} type="hidden" name="service_ids" value={id} />
          ))
        : null}

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        {pending
          ? "Submitting…"
          : showSlotPicker
            ? "Confirm booking"
            : "Submit request"}
      </Button>

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        {isExistingMode
          ? "We'll send confirmation to the contact info already on file."
          : "By submitting, you'll receive SMS and email confirmation. New patients are pre-registered — reception verifies your identity at the counter."}
      </p>
    </form>
      )}
    </div>
  );
}

function PatientModeOption({
  checked,
  onChange,
  title,
  blurb,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`cursor-pointer rounded-xl border p-4 transition-colors ${
        checked
          ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)]"
          : "border-[color:var(--color-brand-bg-mid)] bg-white hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="patient_mode_choice"
          checked={checked}
          onChange={onChange}
          className="mt-1"
        />
        <div>
          <p className="font-semibold text-[color:var(--color-brand-navy)]">
            {title}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {blurb}
          </p>
        </div>
      </div>
    </label>
  );
}

function BranchOption({
  checked,
  onChange,
  title,
  blurb,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`cursor-pointer rounded-xl border p-4 transition-colors ${
        checked
          ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)]"
          : "border-[color:var(--color-brand-bg-mid)] bg-white hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="branch_choice"
          checked={checked}
          onChange={onChange}
          className="mt-1"
        />
        <div>
          <p className="font-semibold text-[color:var(--color-brand-navy)]">
            {title}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {blurb}
          </p>
        </div>
      </div>
    </label>
  );
}

function Disclaimer({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning" | "info";
}) {
  const cls =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-sky-300 bg-sky-50 text-sky-900";
  return (
    <div className={`rounded-lg border p-3 text-xs ${cls}`}>{children}</div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
      />
    </div>
  );
}

function ServiceMultiPicker({
  query,
  onQueryChange,
  services,
  selectedIds,
  onToggle,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  services: ServiceLite[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>Pick services</Label>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          {selectedIds.size} selected · {services.length} shown
        </p>
      </div>
      <Input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search by name or code (CBC, lipid, ultrasound…)"
        className="w-full"
        autoComplete="off"
      />
      <div className="grid max-h-96 gap-1.5 overflow-y-auto rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-2">
        {services.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No services match.
          </p>
        ) : null}
        {services.map((s) => {
          const isOpen = expanded === s.id;
          const isPicked = selectedIds.has(s.id);
          return (
            <div
              key={s.id}
              className={`rounded-md border p-3 text-sm transition-colors ${
                isPicked
                  ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)]"
                  : "border-[color:var(--color-brand-bg-mid)] hover:bg-[color:var(--color-brand-bg)]"
              }`}
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={isPicked}
                  onChange={() => onToggle(s.id)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {s.name}
                      {s.fasting_required ? (
                        <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                          Fasting
                        </span>
                      ) : null}
                      {s.requires_time_slot ? (
                        <span className="ml-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-900">
                          Time slot
                        </span>
                      ) : null}
                    </p>
                    <span className="text-xs font-semibold text-[color:var(--color-brand-cyan)]">
                      {formatPhp(s.price_php)}
                    </span>
                  </div>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {s.code}
                  </p>
                  {s.description ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setExpanded(isOpen ? null : s.id);
                      }}
                      className="mt-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      {isOpen ? "Hide details" : "Show details"}
                    </button>
                  ) : null}
                  {isOpen && s.description ? (
                    <p className="mt-2 whitespace-pre-line text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.description}
                    </p>
                  ) : null}
                </div>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
