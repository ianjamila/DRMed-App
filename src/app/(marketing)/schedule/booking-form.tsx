"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import Link from "next/link";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Beaker,
  CalendarClock,
  Home,
  Info,
  Search,
  Stethoscope,
} from "lucide-react";
import { formatPhp } from "@/lib/marketing/format";
import {
  SlotPicker,
  slotScheduledAt,
  type ClosureLite,
  type SlotValue,
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
import { EcgProgress } from "@/components/marketing/booking-wizard/EcgProgress";
import { StepShell } from "@/components/marketing/booking-wizard/StepShell";
import { ChoiceCard } from "@/components/marketing/booking-wizard/ChoiceCard";
import { Chip } from "@/components/marketing/booking-wizard/Chip";
import { WizardField } from "@/components/marketing/booking-wizard/WizardField";
import { ReviewRows } from "@/components/marketing/booking-wizard/ReviewRows";
import { SuccessPanel } from "@/components/marketing/booking-wizard/SuccessPanel";
import { LabRequestUpload } from "@/components/marketing/booking-wizard/LabRequestUpload";
import type { IntakePreference } from "@/lib/appointments/lab-request";

export type ServiceKind = "lab_test" | "lab_package" | "doctor_consultation";

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
  slug: string;
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
  slug: string;
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
  // When set, the form skips the patient-mode toggle + lookup and submits the
  // booking against this patient. Used by /portal/book — the patient is already
  // authenticated via session, so the server re-derives patient_id from the
  // session cookie regardless of what the form posts.
  prefilledPatient?: PrefilledPatient;
  // Deep-link preselect from /schedule?doctor=<slug>. When provided, the form
  // opens on the doctor_appointment branch with that physician pre-picked and
  // their specialty pre-selected (so the physician picker is immediately visible).
  // Absent = existing defaults apply (lab_request branch, no physician).
  initialBranch?: Branch;
  initialPhysicianId?: string;
  initialSpecialtyCode?: string;
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
    "Pre-built bundles like CBC + Lipid + FBS. Just walk in during operating hours — no scheduling needed.",
  lab_request:
    "Individual lab tests, X-ray, ECG, and ultrasounds. Pick one or more — only ultrasound needs a specific time slot.",
  doctor_appointment:
    "Consultation with one of our specialists. Pick a specialty, then a doctor, then a slot.",
  home_service:
    "We come to your home for the test. Subject to availability — reception will call to confirm.",
};

const BRANCH_ICON: Record<Branch, React.ReactNode> = {
  diagnostic_package: <Beaker className="h-[22px] w-[22px]" strokeWidth={1.8} />,
  lab_request: <Search className="h-[22px] w-[22px]" strokeWidth={1.8} />,
  doctor_appointment: (
    <Stethoscope className="h-[22px] w-[22px]" strokeWidth={1.8} />
  ),
  home_service: <Home className="h-[22px] w-[22px]" strokeWidth={1.8} />,
};

type StepKey = "patient" | "booking" | "details" | "about" | "review";
const STEP_LABEL: Record<StepKey, string> = {
  patient: "Patient",
  booking: "Booking",
  details: "Details",
  about: "About you",
  review: "Review",
};

export function BookingForm({
  services,
  closures,
  startDate,
  specialties,
  physicians,
  byAppointmentPhysicians,
  prefilledPatient,
  initialBranch,
  initialPhysicianId,
  initialSpecialtyCode,
}: Props) {
  const isPortalContext = prefilledPatient !== undefined;

  const [branch, setBranch] = useState<Branch>(initialBranch ?? "lab_request");
  // Personal-info fields stay in controlled state (React 19 resets uncontrolled
  // inputs when a form action returns) and feed the persistent hidden fields.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const [sex, setSex] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [labRequestFiles, setLabRequestFiles] = useState<File[]>([]);
  const [intakePreference, setIntakePreference] = useState<IntakePreference | null>(null);
  const [serviceAgreement, setServiceAgreement] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(
    new Set(),
  );
  const [singleServiceId, setSingleServiceId] = useState<string>("");
  const [specialtyCode, setSpecialtyCode] = useState<string>(initialSpecialtyCode ?? "");
  const [physicianId, setPhysicianId] = useState<string>(initialPhysicianId ?? "");
  const [serviceQuery, setServiceQuery] = useState("");
  const [slot, setSlot] = useState<SlotValue>({ date: null, time: null });
  const [patientMode, setPatientMode] = useState<"new" | "existing">(
    isPortalContext ? "existing" : "new",
  );
  const [resolvedPatient, setResolvedPatient] = useState<{
    id: string;
    drm_id: string;
    first_name: string;
    last_name: string;
  } | null>(prefilledPatient ?? null);
  const [lookupDrmId, setLookupDrmId] = useState("");
  const [lookupLastName, setLookupLastName] = useState("");

  // Wizard position. Portal context starts past the patient step.
  const [stepKey, setStepKey] = useState<StepKey>(
    isPortalContext ? "booking" : "patient",
  );
  const [direction, setDirection] = useState(1);
  const [showErrors, setShowErrors] = useState(false);

  const [lookupState, lookupAction, lookupPending] = useActionState<
    LookupPatientResult | null,
    FormData
  >(async (_prev, formData) => {
    const result = await lookupPatientAction(_prev, formData);
    if (result.ok) setResolvedPatient(result.patient);
    return result;
  }, null);
  const [state, formAction, pending] = useActionState<
    BookingResult | null,
    FormData
  >(submitBookingAction, null);

  // ── Conversion event ref — declared here (hook rules require top-level) ─
  // The effect itself fires after derived variables are in scope (below).
  const trackedRef = useRef(false);

  // ── Derived (identical logic to the original single-page form) ──────────
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

  const consultationServices = useMemo(() => {
    if (!specialtyCode || specialtyCode === "general" || specialtyCode === "all") {
      return allConsultations;
    }
    return allConsultations.filter((s) => s.specialty_code === specialtyCode);
  }, [allConsultations, specialtyCode]);

  const isSpecialtyAutoConsult =
    branch === "doctor_appointment" &&
    specialtyCode !== "" &&
    specialtyCode !== "general" &&
    specialtyCode !== "all" &&
    consultationServices.length === 1;
  const autoConsultService = isSpecialtyAutoConsult
    ? consultationServices[0]!
    : null;

  const physiciansForSpecialty = useMemo(() => {
    if (!specialtyCode) return [];
    if (specialtyCode === "all") return physicians;
    return physicians.filter((p) => p.specialty_codes.includes(specialtyCode));
  }, [physicians, specialtyCode]);

  const byAppointmentForSpecialty = useMemo(() => {
    if (!specialtyCode) return [];
    if (specialtyCode === "all") return byAppointmentPhysicians;
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

  const showFastingDisclaimer =
    (branch === "diagnostic_package" || branch === "lab_request") &&
    Array.from(selectedServiceIds).some(
      (id) => services.find((x) => x.id === id)?.fasting_required,
    );

  const labRequiresSlot =
    branch === "lab_request" &&
    Array.from(selectedServiceIds).some(
      (id) => services.find((x) => x.id === id)?.requires_time_slot,
    );
  const doctorRequiresSlot =
    branch === "doctor_appointment" && selectedPhysician !== null;
  const showSlotPicker = labRequiresSlot || doctorRequiresSlot;

  const physicianAvailability = selectedPhysician
    ? { blocks: selectedPhysician.blocks, overrides: selectedPhysician.overrides }
    : null;

  const scheduledAt = slotScheduledAt(slot);
  const isExistingMode =
    isPortalContext || (patientMode === "existing" && resolvedPatient !== null);
  const doctorServiceId = autoConsultService?.id ?? singleServiceId;

  // ── Conversion event (RA 10173 — payload contains NO PII) ───────────────
  // Fires exactly once on booking success. Branch (enum string, not patient
  // data) + numeric service count are the only payload fields.
  const isSuccess = !!(state?.ok && (state.drm_id || isPortalContext));
  useEffect(() => {
    if (!isSuccess || trackedRef.current) return;
    if (isPortalContext) return; // never emit analytics from the patient portal (RA 10173)
    trackedRef.current = true;
    const serviceCount =
      branch === "doctor_appointment"
        ? doctorServiceId
          ? 1
          : 0
        : selectedServiceIds.size;
    track("booking_submitted", { branch, services: serviceCount });
    // branch/doctorServiceId/selectedServiceIds are frozen once the form is submitted
    // (inputs are locked during pending → success), so the stale closure is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);
  // ────────────────────────────────────────────────────────────────────────

  // Active step list depends on context: portal skips Patient; existing
  // patients skip the "About you" personal-details step.
  const steps: StepKey[] = isPortalContext
    ? ["booking", "details", "review"]
    : patientMode === "existing"
      ? ["patient", "booking", "details", "review"]
      : ["patient", "booking", "details", "about", "review"];
  const stepIndex = Math.max(0, steps.indexOf(stepKey));

  // ── Success screen ──────────────────────────────────────────────────────
  if (state?.ok && (state.drm_id || isPortalContext)) {
    return (
      <SuccessPanel
        drmId={state.drm_id}
        serviceSummary={state.service_summary}
        scheduledAt={state.scheduled_at}
        pendingCallback={state.pending_callback}
        isPortalContext={isPortalContext}
        uploadedFiles={labRequestFiles}
      />
    );
  }

  // ── Per-step validation (mirrors the zod rules, shows the same messages) ─
  function validate(key: StepKey): Record<string, string> {
    const e: Record<string, string> = {};
    if (key === "details") {
      if (branch === "doctor_appointment") {
        if (!specialtyCode) e.specialty = "Pick a specialty.";
        else if (!physicianId) e.physician = "Pick a physician.";
        else if (!doctorServiceId) e.service = "Pick a consultation.";
      } else {
        const hasForm = labRequestFiles.length > 0;
        if (selectedServiceIds.size === 0 && !hasForm) {
          e.services = "Pick at least one test, or upload your doctor's request form.";
        }
        if (hasForm && !intakePreference) {
          e.intake = "Tell us whether you'll walk in or want us to confirm first.";
        }
      }
    } else if (key === "about") {
      if (!firstName.trim()) e.first_name = "First name is required.";
      if (!lastName.trim()) e.last_name = "Last name is required.";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate))
        e.birthdate = "Birthdate must be YYYY-MM-DD.";
      if (phone.trim().length < 7)
        e.phone = "Phone is required for SMS confirmation.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
        e.email = "Valid email required for confirmation.";
    } else if (key === "review") {
      if (!isPortalContext && !serviceAgreement)
        e.agreement = "Please accept the service agreement to continue.";
    }
    return e;
  }

  const currentErrors = showErrors ? validate(stepKey) : {};

  function goNext() {
    const errs = validate(stepKey);
    if (Object.keys(errs).length > 0) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setDirection(1);
    setStepKey(steps[stepIndex + 1] ?? stepKey);
  }
  function goBack() {
    setShowErrors(false);
    setDirection(-1);
    setStepKey(steps[stepIndex - 1] ?? stepKey);
  }
  function jumpTo(key: StepKey) {
    setShowErrors(false);
    setDirection(steps.indexOf(key) < stepIndex ? -1 : 1);
    setStepKey(key);
  }

  // Files live in React state (not a DOM <input type=file>) so they survive
  // step navigation + the React-19 form re-render. Append them at submit time.
  const submitWithFiles = (formData: FormData) => {
    for (const f of labRequestFiles) formData.append("lab_request_files", f, f.name);
    if (intakePreference) formData.append("intake_preference", intakePreference);
    return formAction(formData);
  };

  // The patient step (and its lookup form) lives outside the booking <form>
  // because nested forms are illegal. Continue is gated until a record resolves.
  const canContinuePatient = patientMode === "new" || resolvedPatient !== null;

  // Reduced motion is honored by MotionConfig below (skips the x transform,
  // keeps the opacity fade) — we don't branch the render on it.
  const slide = {
    initial: { opacity: 0, x: direction * 36 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: direction * -36 },
    transition: { duration: 0.35, ease: [0.2, 0.7, 0.3, 1] as const },
  };

  return (
    <MotionConfig reducedMotion="user">
    <div>
      <EcgProgress steps={steps.map((s) => STEP_LABEL[s])} current={stepIndex} />

      <div className="mt-6 rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] sm:p-10">
        {/* ── PATIENT step (outside the booking form) ─────────────────────── */}
        {stepKey === "patient" ? (
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div key="patient" {...slide}>
              <StepShell
                kicker="Step 1 · Patient"
                title={
                  <>
                    Have you visited{" "}
                    <span className="italic text-[color:var(--color-brand-cyan)]">
                      DRMed before?
                    </span>
                  </>
                }
                sub="New patients get a DRM-ID on the spot. Existing patients can skip retyping their details."
              >
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <ChoiceCard
                    selected={patientMode === "new"}
                    onSelect={() => {
                      setPatientMode("new");
                      setResolvedPatient(null);
                    }}
                    title="No, I'm new"
                    blurb="First time at DRMed. We'll register you and assign a DRM-ID."
                  />
                  <ChoiceCard
                    selected={patientMode === "existing"}
                    onSelect={() => setPatientMode("existing")}
                    title="Yes, I have a DRM-ID"
                    blurb="From a previous receipt. Skip retyping your details."
                  />
                </div>

                {patientMode === "existing" && !resolvedPatient ? (
                  <form
                    action={lookupAction}
                    className="mt-4 grid gap-3 rounded-[18px] bg-[color:var(--color-warm-sand)] p-5"
                  >
                    <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
                      Find your record
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <WizardField
                        label="DRM-ID"
                        value={lookupDrmId}
                        onChange={setLookupDrmId}
                        placeholder="DRM-0001"
                        maxLength={20}
                        autoComplete="off"
                      />
                      <WizardField
                        label="Last name on file"
                        value={lookupLastName}
                        onChange={setLookupLastName}
                        maxLength={80}
                        autoComplete="off"
                      />
                    </div>
                    {/* Hidden inputs carry the controlled values to the action. */}
                    <input type="hidden" name="drm_id" value={lookupDrmId} />
                    <input type="hidden" name="last_name" value={lookupLastName} />
                    {lookupState && !lookupState.ok ? (
                      <p className="text-sm text-[color:var(--color-danger)]" role="alert">
                        {lookupState.error}
                      </p>
                    ) : null}
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={lookupPending}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[color:var(--color-brand-navy)] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-ink)] disabled:opacity-60"
                      >
                        {lookupPending ? "Looking up…" : "Look up"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {patientMode === "existing" && resolvedPatient ? (
                  <div className="mt-4 flex items-start justify-between gap-3 rounded-[18px] border border-[color:var(--color-brand-cyan)] bg-[rgba(8,168,226,0.06)] p-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                        Booking as
                      </p>
                      <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
                        {resolvedPatient.first_name} {resolvedPatient.last_name}
                      </p>
                      <p className="text-xs text-[color:var(--color-ink-soft)]">
                        {resolvedPatient.drm_id}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setResolvedPatient(null)}
                      className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)] hover:underline"
                    >
                      Use a different patient
                    </button>
                  </div>
                ) : null}

                <div className="mt-8 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!canContinuePatient}
                    className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full bg-[color:var(--color-brand-cyan)] px-6 py-3 text-[14.5px] font-bold text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] transition hover:-translate-y-px hover:bg-[color:var(--color-brand-navy)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Continue <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </StepShell>
            </motion.div>
          </AnimatePresence>
        ) : (
          // ── The booking form wraps every step after Patient. The visible
          // step is pure state UI; HiddenFields carries all values to submit. ─
          <form action={submitWithFiles}>
            <HiddenFields
              branch={branch}
              isPortalContext={isPortalContext}
              isExistingMode={isExistingMode}
              resolvedPatientId={resolvedPatient?.id ?? null}
              firstName={firstName}
              lastName={lastName}
              middleName={middleName}
              birthdate={birthdate}
              sex={sex}
              phone={phone}
              email={email}
              address={address}
              notes={notes}
              serviceAgreement={serviceAgreement}
              marketingConsent={marketingConsent}
              selectedServiceIds={selectedServiceIds}
              doctorServiceId={doctorServiceId}
              physicianId={physicianId}
              scheduledAt={scheduledAt}
            />

            <AnimatePresence mode="wait" custom={direction}>
              <motion.div key={stepKey} {...slide}>
                {stepKey === "booking" ? (
                  <StepShell
                    kicker="Step 2 · Booking"
                    title={
                      <>
                        What are you{" "}
                        <span className="italic text-[color:var(--color-brand-cyan)]">
                          booking?
                        </span>
                      </>
                    }
                    sub="Pick the kind of visit. You can change this later."
                  >
                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                      {(Object.keys(KINDS_PER_BRANCH) as Branch[]).map((b) => (
                        <ChoiceCard
                          key={b}
                          selected={branch === b}
                          onSelect={() => {
                            setBranch(b);
                            setSelectedServiceIds(new Set());
                            setSingleServiceId("");
                            setSpecialtyCode("");
                            setPhysicianId("");
                            setSlot({ date: null, time: null });
                            setLabRequestFiles([]);
                            setIntakePreference(null);
                          }}
                          icon={BRANCH_ICON[b]}
                          title={BRANCH_LABELS[b]}
                          blurb={BRANCH_BLURBS[b]}
                        />
                      ))}
                    </div>
                  </StepShell>
                ) : null}

                {stepKey === "details" ? (
                  <DetailsStep
                    branch={branch}
                    services={services}
                    filteredServices={filteredServices}
                    selectedServiceIds={selectedServiceIds}
                    onToggleService={(id) =>
                      setSelectedServiceIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    serviceQuery={serviceQuery}
                    onServiceQuery={setServiceQuery}
                    specialties={specialties}
                    specialtyCode={specialtyCode}
                    onSpecialty={(v) => {
                      setSpecialtyCode(v);
                      setPhysicianId("");
                      setSingleServiceId("");
                    }}
                    physiciansForSpecialty={physiciansForSpecialty}
                    byAppointmentForSpecialty={byAppointmentForSpecialty}
                    physicianId={physicianId}
                    onPhysician={setPhysicianId}
                    consultationServices={consultationServices}
                    autoConsultService={autoConsultService}
                    singleServiceId={singleServiceId}
                    onSingleService={setSingleServiceId}
                    isByAppointment={isByAppointment}
                    showSlotPicker={showSlotPicker}
                    startDate={startDate}
                    closures={closures}
                    availability={physicianAvailability}
                    slot={slot}
                    onSlot={setSlot}
                    showFastingDisclaimer={showFastingDisclaimer}
                    notes={notes}
                    onNotes={setNotes}
                    errors={currentErrors}
                    showLabRequestUpload={branch !== "doctor_appointment"}
                    labRequestFiles={labRequestFiles}
                    onLabRequestFilesChange={setLabRequestFiles}
                    intakePreference={intakePreference}
                    onIntakePreferenceChange={setIntakePreference}
                  />
                ) : null}

                {stepKey === "about" ? (
                  <StepShell
                    kicker="Step 4 · About you"
                    title={
                      <>
                        Tell us{" "}
                        <span className="italic text-[color:var(--color-brand-cyan)]">
                          about you.
                        </span>
                      </>
                    }
                    sub="We verify your identity at the counter on arrival."
                  >
                    <div className="mt-6 grid gap-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <WizardField
                          label="First name"
                          required
                          value={firstName}
                          onChange={setFirstName}
                          maxLength={80}
                          error={currentErrors.first_name}
                          valid={firstName.trim().length > 0}
                        />
                        <WizardField
                          label="Last name"
                          required
                          value={lastName}
                          onChange={setLastName}
                          maxLength={80}
                          error={currentErrors.last_name}
                          valid={lastName.trim().length > 0}
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <WizardField
                          label="Middle name"
                          value={middleName}
                          onChange={setMiddleName}
                          maxLength={80}
                        />
                        <WizardField
                          label="Birthdate"
                          type="date"
                          required
                          value={birthdate}
                          onChange={setBirthdate}
                          error={currentErrors.birthdate}
                          valid={/^\d{4}-\d{2}-\d{2}$/.test(birthdate)}
                        />
                        <div className="flex flex-col gap-1.5">
                          <label
                            htmlFor="wiz-sex"
                            className="text-[13.5px] font-semibold text-[color:var(--color-ink)]"
                          >
                            Sex
                          </label>
                          <select
                            id="wiz-sex"
                            value={sex}
                            onChange={(e) => setSex(e.target.value)}
                            className="h-[46px] rounded-[12px] border-[1.5px] border-[color:var(--color-warm-line)] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)]"
                          >
                            <option value="">—</option>
                            <option value="female">Female</option>
                            <option value="male">Male</option>
                          </select>
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <WizardField
                          label="Phone"
                          type="tel"
                          required
                          inputMode="tel"
                          placeholder="+639XXXXXXXXX or 09XX…"
                          value={phone}
                          onChange={setPhone}
                          maxLength={40}
                          error={currentErrors.phone}
                          valid={phone.trim().length >= 7}
                        />
                        <WizardField
                          label="Email"
                          type="email"
                          required
                          inputMode="email"
                          value={email}
                          onChange={setEmail}
                          maxLength={160}
                          error={currentErrors.email}
                          valid={/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())}
                        />
                      </div>
                      <WizardField
                        label="Address"
                        value={address}
                        onChange={setAddress}
                        maxLength={200}
                        placeholder="Optional — helpful for home service"
                      />
                    </div>
                  </StepShell>
                ) : null}

                {stepKey === "review" ? (
                  <ReviewStep
                    branch={branch}
                    services={services}
                    selectedServiceIds={selectedServiceIds}
                    doctorServiceId={doctorServiceId}
                    physicians={physicians}
                    byAppointmentPhysicians={byAppointmentPhysicians}
                    physicianId={physicianId}
                    isByAppointment={isByAppointment}
                    scheduledAt={scheduledAt}
                    isExistingMode={isExistingMode}
                    resolvedPatientName={
                      resolvedPatient
                        ? `${resolvedPatient.first_name} ${resolvedPatient.last_name}`
                        : `${firstName} ${lastName}`.trim()
                    }
                    notes={notes}
                    isPortalContext={isPortalContext}
                    serviceAgreement={serviceAgreement}
                    onServiceAgreement={setServiceAgreement}
                    marketingConsent={marketingConsent}
                    onMarketingConsent={setMarketingConsent}
                    errors={currentErrors}
                    onJump={jumpTo}
                    hasAboutStep={steps.includes("about")}
                    submitError={state && !state.ok ? state.error : null}
                    pending={pending}
                    showSlotPicker={showSlotPicker}
                    labRequestCount={labRequestFiles.length}
                    intakePreference={intakePreference}
                  />
                ) : null}
              </motion.div>
            </AnimatePresence>

            {/* Step navigation — Submit lives on the Review step only. */}
            <div className="mt-8 flex items-center justify-between gap-3">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex min-h-[46px] items-center gap-2 rounded-full px-3.5 py-3 text-[14.5px] font-bold text-[color:var(--color-ink-mid)] transition hover:text-[color:var(--color-brand-navy)]"
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </button>
              ) : (
                <span />
              )}

              {stepKey === "review" ? (
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full bg-[color:var(--color-brand-cyan)] px-7 py-3 text-[14.5px] font-bold text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] transition hover:-translate-y-px hover:bg-[color:var(--color-brand-navy)] hover:text-white disabled:opacity-60"
                >
                  {pending
                    ? "Submitting…"
                    : showSlotPicker
                      ? "Confirm booking"
                      : "Submit request"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full bg-[color:var(--color-brand-cyan)] px-7 py-3 text-[14.5px] font-bold text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] transition hover:-translate-y-px hover:bg-[color:var(--color-brand-navy)] hover:text-white"
                >
                  Continue <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      <p className="mx-auto mt-4 flex max-w-[760px] items-start gap-2 px-2 text-xs text-[color:var(--color-ink-soft)]">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
        {isExistingMode
          ? "We'll send confirmation to the contact info already on file."
          : "By submitting, you'll receive an email confirmation. New patients are pre-registered — reception verifies your identity at the counter. For corporate or HMO bookings, message us instead."}
      </p>
    </div>
    </MotionConfig>
  );
}

// ── Persistent hidden fields: the single source of truth posted to the server.
// Visible step controls have no `name=`; everything submits from here, so steps
// can mount/unmount (slide) freely without losing form data. ──────────────────
function HiddenFields({
  branch,
  isPortalContext,
  isExistingMode,
  resolvedPatientId,
  firstName,
  lastName,
  middleName,
  birthdate,
  sex,
  phone,
  email,
  address,
  notes,
  serviceAgreement,
  marketingConsent,
  selectedServiceIds,
  doctorServiceId,
  physicianId,
  scheduledAt,
}: {
  branch: Branch;
  isPortalContext: boolean;
  isExistingMode: boolean;
  resolvedPatientId: string | null;
  firstName: string;
  lastName: string;
  middleName: string;
  birthdate: string;
  sex: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  serviceAgreement: boolean;
  marketingConsent: boolean;
  selectedServiceIds: Set<string>;
  doctorServiceId: string;
  physicianId: string;
  scheduledAt: string;
}) {
  return (
    <>
      <input type="hidden" name="branch" value={branch} />
      {isPortalContext ? <input type="hidden" name="source" value="portal" /> : null}
      {isExistingMode && resolvedPatientId ? (
        <input type="hidden" name="patient_id" value={resolvedPatientId} />
      ) : null}

      {/* Honeypot — real off-screen input bots tend to fill. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {!isExistingMode ? (
        <>
          <input type="hidden" name="first_name" value={firstName} />
          <input type="hidden" name="last_name" value={lastName} />
          <input type="hidden" name="middle_name" value={middleName} />
          <input type="hidden" name="birthdate" value={birthdate} />
          <input type="hidden" name="sex" value={sex} />
          <input type="hidden" name="phone" value={phone} />
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="address" value={address} />
        </>
      ) : null}

      <input type="hidden" name="notes" value={notes} />
      <input
        type="hidden"
        name="service_agreement"
        value={serviceAgreement ? "on" : "off"}
      />
      <input
        type="hidden"
        name="marketing_consent"
        value={marketingConsent ? "on" : "off"}
      />

      {branch === "doctor_appointment" ? (
        <>
          <input type="hidden" name="service_id" value={doctorServiceId} />
          <input type="hidden" name="physician_id" value={physicianId} />
        </>
      ) : (
        Array.from(selectedServiceIds).map((id) => (
          <input key={id} type="hidden" name="service_ids" value={id} />
        ))
      )}

      <input type="hidden" name="scheduled_at" value={scheduledAt} />
    </>
  );
}

// ── Details step body ─────────────────────────────────────────────────────
function DetailsStep(props: {
  branch: Branch;
  services: ServiceLite[];
  filteredServices: ServiceLite[];
  selectedServiceIds: Set<string>;
  onToggleService: (id: string) => void;
  serviceQuery: string;
  onServiceQuery: (q: string) => void;
  specialties: SpecialtyOption[];
  specialtyCode: string;
  onSpecialty: (v: string) => void;
  physiciansForSpecialty: BookablePhysician[];
  byAppointmentForSpecialty: ByAppointmentPhysician[];
  physicianId: string;
  onPhysician: (v: string) => void;
  consultationServices: ServiceLite[];
  autoConsultService: ServiceLite | null;
  singleServiceId: string;
  onSingleService: (v: string) => void;
  isByAppointment: boolean;
  showSlotPicker: boolean;
  startDate: string;
  closures: ClosureLite[];
  availability: { blocks: AvailabilityBlock[]; overrides: AvailabilityOverride[] } | null;
  slot: SlotValue;
  onSlot: (v: SlotValue) => void;
  showFastingDisclaimer: boolean;
  notes: string;
  onNotes: (v: string) => void;
  showLabRequestUpload: boolean;
  labRequestFiles: File[];
  onLabRequestFilesChange: (next: File[]) => void;
  intakePreference: IntakePreference | null;
  onIntakePreferenceChange: (p: IntakePreference) => void;
  errors: Record<string, string>;
}) {
  const {
    branch,
    filteredServices,
    selectedServiceIds,
    onToggleService,
    serviceQuery,
    onServiceQuery,
    specialties,
    specialtyCode,
    onSpecialty,
    physiciansForSpecialty,
    byAppointmentForSpecialty,
    physicianId,
    onPhysician,
    consultationServices,
    autoConsultService,
    singleServiceId,
    onSingleService,
    isByAppointment,
    showSlotPicker,
    startDate,
    closures,
    availability,
    slot,
    onSlot,
    showFastingDisclaimer,
    notes,
    onNotes,
    showLabRequestUpload,
    labRequestFiles,
    onLabRequestFilesChange,
    intakePreference,
    onIntakePreferenceChange,
    errors,
  } = props;

  return (
    <StepShell
      kicker="Step 3 · Details"
      title={
        <>
          The{" "}
          <span className="italic text-[color:var(--color-brand-cyan)]">details.</span>
        </>
      }
      sub={BRANCH_BLURBS[branch]}
    >
      {branch === "diagnostic_package" ? (
        <div className="mt-5 rounded-[18px] bg-[color:var(--color-warm-sand)] p-5">
          <h4 className="font-[family-name:var(--font-display)] text-[21px] text-[color:var(--color-brand-navy)]">
            Just walk in — no slot needed
          </h4>
          <ul className="mt-3 grid gap-2.5 text-sm text-[color:var(--color-ink-mid)]">
            <li className="flex items-start gap-2.5">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
              Monday – Saturday, 8:00 AM – 5:00 PM (last registration 4:30 PM).
            </li>
            <li className="flex items-start gap-2.5">
              <Home className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
              4/F Northridge Plaza, Congressional Avenue, Quezon City.
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
              Bring a valid ID and your HMO card if applicable. Some tests need
              fasting — pick your package below to see flags.
            </li>
          </ul>
          <p className="mt-3 text-[13px] text-[color:var(--color-ink-soft)]">
            Pre-registering below is optional — it just saves time at the counter.
          </p>
        </div>
      ) : null}

      {branch === "home_service" ? (
        <Disclaimer tone="info">
          Home service is subject to availability. Reception will contact you
          directly to confirm the requested appointment and fee.
        </Disclaimer>
      ) : null}

      {branch === "doctor_appointment" ? (
        <div className="mt-6 grid gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wiz-specialty" className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
              Specialty <span className="text-[color:var(--color-danger)]">*</span>
            </label>
            <select
              id="wiz-specialty"
              value={specialtyCode}
              onChange={(e) => onSpecialty(e.target.value)}
              className={`h-[46px] rounded-[12px] border-[1.5px] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)] ${
                errors.specialty
                  ? "border-[color:var(--color-danger)]"
                  : "border-[color:var(--color-warm-line)]"
              }`}
            >
              <option value="">— Pick a specialty —</option>
              <option value="all">All specialties</option>
              {specialties.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
            {errors.specialty ? (
              <p className="text-[12.5px] text-[color:var(--color-danger)]">{errors.specialty}</p>
            ) : null}
          </div>

          {specialtyCode ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="wiz-physician" className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
                Physician <span className="text-[color:var(--color-danger)]">*</span>
              </label>
              <select
                id="wiz-physician"
                value={physicianId}
                onChange={(e) => onPhysician(e.target.value)}
                className={`h-[46px] rounded-[12px] border-[1.5px] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)] ${
                  errors.physician
                    ? "border-[color:var(--color-danger)]"
                    : "border-[color:var(--color-warm-line)]"
                }`}
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
              {errors.physician ? (
                <p className="text-[12.5px] text-[color:var(--color-danger)]">{errors.physician}</p>
              ) : null}
              {physiciansForSpecialty.length === 0 &&
              byAppointmentForSpecialty.length === 0 ? (
                <p className="text-xs text-[color:var(--color-warning)]">
                  No physicians match this specialty yet.
                </p>
              ) : null}
            </div>
          ) : null}

          {physicianId ? (
            autoConsultService ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
                  Consultation type
                </span>
                <div className="rounded-[12px] border-[1.5px] border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] px-[13px] py-2.5 text-sm font-semibold text-[color:var(--color-brand-navy)]">
                  {autoConsultService.name}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wiz-consult" className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
                  Consultation type <span className="text-[color:var(--color-danger)]">*</span>
                </label>
                <select
                  id="wiz-consult"
                  value={singleServiceId}
                  onChange={(e) => onSingleService(e.target.value)}
                  className={`h-[46px] rounded-[12px] border-[1.5px] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)] ${
                    errors.service
                      ? "border-[color:var(--color-danger)]"
                      : "border-[color:var(--color-warm-line)]"
                  }`}
                >
                  <option value="">— Pick a consultation —</option>
                  {consultationServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {errors.service ? (
                  <p className="text-[12.5px] text-[color:var(--color-danger)]">{errors.service}</p>
                ) : null}
                {consultationServices.length === 0 ? (
                  <p className="text-xs text-[color:var(--color-warning)]">
                    No consultations are configured for this specialty yet. Please call reception.
                  </p>
                ) : null}
              </div>
            )
          ) : null}

          {isByAppointment ? (
            <Disclaimer tone="info">
              This physician is by appointment only — reception will call you to
              confirm a date and time.
            </Disclaimer>
          ) : null}
        </div>
      ) : (
        <>
          {showLabRequestUpload ? (
            <LabRequestUpload
              files={labRequestFiles}
              onFilesChange={onLabRequestFilesChange}
              preference={intakePreference}
              onPreferenceChange={onIntakePreferenceChange}
              error={errors.intake}
            />
          ) : null}
          <ServiceMultiPicker
            isPackages={branch === "diagnostic_package"}
            query={serviceQuery}
            onQueryChange={onServiceQuery}
            services={filteredServices}
            selectedIds={selectedServiceIds}
            onToggle={onToggleService}
            error={errors.services}
          />
        </>
      )}

      {showSlotPicker ? (
        <div className="mt-5 rounded-[18px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-sand)] p-5">
          <SlotPicker
            startDate={startDate}
            closures={closures}
            availability={availability}
            value={slot}
            onChange={onSlot}
          />
        </div>
      ) : null}

      {showFastingDisclaimer ? (
        <Disclaimer tone="warning">
          Some tests need to be taken while fasted (e.g. FBS, Lipid Profile,
          OGTT). Fasting-required services are flagged in the list. When in
          doubt, call reception before your visit.
        </Disclaimer>
      ) : null}

      <div className="mt-5 flex flex-col gap-1.5">
        <label htmlFor="wiz-notes" className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
          Notes (optional)
        </label>
        <textarea
          id="wiz-notes"
          rows={3}
          maxLength={2000}
          placeholder="HMO, fasting needed, mobility, etc."
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
          className="rounded-[12px] border-[1.5px] border-[color:var(--color-warm-line)] bg-white px-[13px] py-2.5 text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)]"
        />
      </div>
    </StepShell>
  );
}

// ── Review step body ──────────────────────────────────────────────────────
function ReviewStep(props: {
  branch: Branch;
  services: ServiceLite[];
  selectedServiceIds: Set<string>;
  doctorServiceId: string;
  physicians: BookablePhysician[];
  byAppointmentPhysicians: ByAppointmentPhysician[];
  physicianId: string;
  isByAppointment: boolean;
  scheduledAt: string;
  isExistingMode: boolean;
  resolvedPatientName: string;
  notes: string;
  isPortalContext: boolean;
  serviceAgreement: boolean;
  onServiceAgreement: (v: boolean) => void;
  marketingConsent: boolean;
  onMarketingConsent: (v: boolean) => void;
  labRequestCount: number;
  intakePreference: IntakePreference | null;
  errors: Record<string, string>;
  onJump: (key: StepKey) => void;
  hasAboutStep: boolean;
  submitError: string | null;
  pending: boolean;
  showSlotPicker: boolean;
}) {
  const {
    branch,
    services,
    selectedServiceIds,
    doctorServiceId,
    physicians,
    byAppointmentPhysicians,
    physicianId,
    scheduledAt,
    isExistingMode,
    resolvedPatientName,
    notes,
    isPortalContext,
    serviceAgreement,
    onServiceAgreement,
    marketingConsent,
    onMarketingConsent,
    labRequestCount,
    intakePreference,
    errors,
    onJump,
    hasAboutStep,
    submitError,
  } = props;

  const serviceNames =
    branch === "doctor_appointment"
      ? services.filter((s) => s.id === doctorServiceId).map((s) => s.name)
      : services
          .filter((s) => selectedServiceIds.has(s.id))
          .map((s) => s.name);

  const physician =
    physicians.find((p) => p.id === physicianId) ??
    byAppointmentPhysicians.find((p) => p.id === physicianId) ??
    null;

  const whenLabel = scheduledAt
    ? new Date(scheduledAt).toLocaleString("en-PH", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Asia/Manila",
      })
    : null;

  const rows = [
    {
      label: "Booking",
      value: BRANCH_LABELS[branch],
      onEdit: () => onJump("booking"),
    },
    {
      label: branch === "doctor_appointment" ? "Consultation" : "Services",
      value: serviceNames.length ? serviceNames.join(", ") : "—",
      onEdit: () => onJump("details"),
    },
    ...(physician
      ? [{ label: "Physician", value: `${physician.full_name} · ${physician.specialty}` }]
      : []),
    ...(whenLabel
      ? [{ label: "When", value: whenLabel, onEdit: () => onJump("details") }]
      : []),
    {
      label: "Patient",
      value: isExistingMode ? resolvedPatientName || "On file" : resolvedPatientName || "New patient",
      ...(hasAboutStep ? { onEdit: () => onJump("about") } : {}),
    },
    ...(labRequestCount > 0
      ? [
          {
            label: "Request form",
            value: `${labRequestCount} file${labRequestCount > 1 ? "s" : ""} attached · ${
              intakePreference === "callback"
                ? "we'll confirm tests/price with you"
                : "walk in — reception reads it at the counter"
            }`,
            onEdit: () => onJump("details"),
          },
        ]
      : []),
    ...(notes.trim() ? [{ label: "Notes", value: notes.trim() }] : []),
  ];

  return (
    <StepShell
      kicker="Step 5 · Review"
      title={
        <>
          Almost{" "}
          <span className="italic text-[color:var(--color-brand-cyan)]">there.</span>
        </>
      }
      sub="Double-check your booking, then confirm."
    >
      <ReviewRows rows={rows} />

      <div className="mt-5 grid gap-3 rounded-[18px] bg-[color:var(--color-warm-sand)] p-5 text-sm">
        {!isPortalContext ? (
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={serviceAgreement}
              onChange={(e) => onServiceAgreement(e.target.checked)}
              className="mt-0.5 h-5 w-5 accent-[color:var(--color-brand-cyan)]"
            />
            <span className="text-[color:var(--color-ink-mid)]">
              <span className="font-semibold text-[color:var(--color-brand-navy)]">
                Service agreement (required).
              </span>{" "}
              I consent to drmed.ph processing my contact details to fulfil this
              booking under the Philippine Data Privacy Act (RA 10173). Lab
              results are released only after payment. See the{" "}
              <Link href="/privacy" className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2">
                Privacy Notice
              </Link>
              .
            </span>
          </label>
        ) : null}
        {errors.agreement ? (
          <p className="text-[12.5px] text-[color:var(--color-danger)]" role="alert">
            {errors.agreement}
          </p>
        ) : null}
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => onMarketingConsent(e.target.checked)}
            className="mt-0.5 h-5 w-5 accent-[color:var(--color-brand-cyan)]"
          />
          <span className="text-[color:var(--color-ink-mid)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              Newsletter (optional).
            </span>{" "}
            Send me occasional updates on new tests, promos, and clinic
            announcements. One-click unsubscribe in every email.
          </span>
        </label>
      </div>

      {submitError ? (
        <p className="mt-4 rounded-[12px] bg-[rgba(194,64,47,0.08)] px-4 py-3 text-sm text-[color:var(--color-danger)]" role="alert">
          {submitError}
        </p>
      ) : null}
    </StepShell>
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
    <div className={`mt-5 rounded-[12px] border p-3.5 text-xs ${cls}`}>{children}</div>
  );
}

// Searchable multi-select used for packages (few) and lab tests (hundreds).
// Kept as a searchable list rather than chips so it scales to the real catalog.
function ServiceMultiPicker({
  isPackages,
  query,
  onQueryChange,
  services,
  selectedIds,
  onToggle,
  error,
}: {
  isPackages: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  services: ServiceLite[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  error?: string;
}) {
  // Packages are few — render as chips. Tests/home are many — searchable list.
  if (isPackages) {
    return (
      <div className="mt-6 grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
            Pick package(s) <span className="text-[color:var(--color-danger)]">*</span>
          </span>
          <span className="text-xs text-[color:var(--color-ink-soft)]">
            {selectedIds.size} selected
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {services.map((s) => (
            <Chip
              key={s.id}
              selected={selectedIds.has(s.id)}
              onClick={() => onToggle(s.id)}
              price={s.price_php ? formatPhp(s.price_php) : undefined}
              title={s.description ?? undefined}
            >
              {s.name}
            </Chip>
          ))}
          {services.length === 0 ? (
            <p className="text-sm text-[color:var(--color-ink-soft)]">No packages match.</p>
          ) : null}
        </div>
        {error ? (
          <p className="text-[12.5px] text-[color:var(--color-danger)]">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
          Pick services <span className="text-[color:var(--color-danger)]">*</span>
        </span>
        <span className="text-xs text-[color:var(--color-ink-soft)]">
          {selectedIds.size} selected · {services.length} shown
        </span>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-ink-soft)]" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by name or code (CBC, lipid, ultrasound…)"
          autoComplete="off"
          className="h-[46px] w-full rounded-[12px] border-[1.5px] border-[color:var(--color-warm-line)] bg-white pl-9 pr-3 text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)]"
        />
      </div>
      <div className="grid max-h-96 gap-1.5 overflow-y-auto rounded-[14px] border border-[color:var(--color-warm-line-soft)] bg-white p-2">
        {services.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[color:var(--color-ink-soft)]">
            No services match.
          </p>
        ) : null}
        {services.map((s) => {
          const isPicked = selectedIds.has(s.id);
          return (
            <label
              key={s.id}
              className={`flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 text-sm transition-colors ${
                isPicked
                  ? "border-[color:var(--color-brand-cyan)] bg-[rgba(8,168,226,0.06)]"
                  : "border-[color:var(--color-warm-line-soft)] hover:bg-[color:var(--color-warm-sand)]"
              }`}
            >
              <input
                type="checkbox"
                checked={isPicked}
                onChange={() => onToggle(s.id)}
                className="mt-1 h-4 w-4 accent-[color:var(--color-brand-cyan)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold text-[color:var(--color-brand-navy)]">
                      {s.name}
                    </span>
                    <span className="text-xs text-[color:var(--color-ink-soft)]">{s.code}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {s.fasting_required ? (
                      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                        Fasting
                      </span>
                    ) : null}
                    {s.requires_time_slot ? (
                      <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-900">
                        Time slot
                      </span>
                    ) : null}
                  </span>
                </span>
                {s.description ? (
                  <span className="mt-1 block whitespace-pre-line text-xs text-[color:var(--color-ink-soft)]">
                    {s.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="text-[12.5px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
