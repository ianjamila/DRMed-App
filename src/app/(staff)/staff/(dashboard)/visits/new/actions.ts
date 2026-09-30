"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { generatePin, hashPin } from "@/lib/auth/pin";
import { setVisitPinFlash } from "@/lib/auth/visit-pin-flash";
import { doctorLineBase, splitDoctorFee } from "@/lib/visits/consultation-fee";
import { isDoctorKind, partitionByCategory } from "@/lib/visits/order-lines";
import { isConsultOnlyOrder } from "@/lib/visits/receipt-policy";
import { isSeniorPwdEligible } from "@/lib/pricing/senior";
import { lineDiscount } from "@/lib/pricing/discounts";
import { assertPatientActive } from "@/lib/patients/require-active";
import { parseReferralAnswer } from "@/lib/patients/referral-sources";
import {
  completeAppointmentFromVisitAction,
  completeArrivedAppointmentsForPatientAction,
} from "../../appointments/actions";
import { buildEncounterVisit, type EncounterDecomposition, type EncounterVisitPayload } from "@/lib/visits/encounter-payload";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent } from "@/lib/server/action-helpers";
import type { Database, Json } from "@/types/database";

const optionalUuid = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().uuid().nullable());

const optionalDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable());

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const Schema = z.object({
  patient_id: z.string().uuid("Pick a valid patient."),
  // The "arrived" appointment reception started this visit from, if any
  // (absent for walk-ins). Optional and best-effort — see the completion
  // call near the end of createVisitAction.
  appointment_id: optionalUuid,
  service_ids: z
    .array(z.string().uuid())
    .min(1, "Select at least one service."),
  // Per-section HMO: doctor lines and lab lines each carry their own provider.
  doctor_hmo_provider_id: optionalUuid,
  doctor_hmo_approval_date: optionalDate,
  doctor_hmo_authorization_no: optionalText(80),
  lab_hmo_provider_id: optionalUuid,
  lab_hmo_approval_date: optionalDate,
  lab_hmo_authorization_no: optionalText(80),
  receptionist_remarks: optionalText(40),
  notes: z.string().trim().max(2000).optional(),
  attending_physician_id: optionalUuid,
  // "Sample / training visit" tick (0181). A checkbox posts "on" or nothing.
  is_sample: z
    .union([z.literal("on"), z.null(), z.undefined()])
    .transform((v) => v === "on"),
});

export type CreateVisitResult =
  | { ok: true; visit_id: string }
  | { ok: false; error: string };

export async function createVisitAction(
  _prev: CreateVisitResult | null,
  formData: FormData,
): Promise<CreateVisitResult> {
  const session = await requireActiveStaff();
  // Defence in depth: creating a visit is a reception/admin action, matching
  // the sibling money/intake actions (e.g. reissuePatientPinAction,
  // createStaffAppointmentAction). Not reachable through the nav for other
  // roles today, but every write action here should still carry its own gate.
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Only reception or admin can create a visit." };
  }

  const parsed = Schema.safeParse({
    patient_id: formData.get("patient_id"),
    appointment_id: formData.get("appointment_id"),
    service_ids: formData.getAll("service_ids"),
    doctor_hmo_provider_id: formData.get("doctor_hmo_provider_id"),
    doctor_hmo_approval_date: formData.get("doctor_hmo_approval_date"),
    doctor_hmo_authorization_no: formData.get("doctor_hmo_authorization_no"),
    lab_hmo_provider_id: formData.get("lab_hmo_provider_id"),
    lab_hmo_approval_date: formData.get("lab_hmo_approval_date"),
    lab_hmo_authorization_no: formData.get("lab_hmo_authorization_no"),
    receptionist_remarks: formData.get("receptionist_remarks"),
    notes: formData.get("notes") ?? "",
    attending_physician_id: formData.get("attending_physician_id"),
    is_sample: formData.get("is_sample"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();

  // 0167/0184: friendly refusal before any pricing work; create_visit_encounter
  // re-checks under the lifecycle lock.
  const active = await assertPatientActive(createAdminClient(), parsed.data.patient_id);
  if (!active.ok) return { ok: false, error: active.error };

  const { data: services, error: svcErr } = await supabase
    .from("services")
    .select(
      "id, kind, code, name, price_php, hmo_price_php, senior_pwd_eligible, is_active",
    )
    .in("id", parsed.data.service_ids);

  if (svcErr || !services || services.length !== parsed.data.service_ids.length) {
    return { ok: false, error: "One or more services could not be found." };
  }

  // M8: mirror the package-component path's is_active guard (below) — a
  // deactivated service must not be orderable on a new visit either.
  const inactiveTopLevel = services.filter((s) => s.is_active === false);
  if (inactiveTopLevel.length > 0) {
    const codes = inactiveTopLevel.map((s) => s.code).join(", ");
    return {
      ok: false,
      error: `Selected services are no longer active: ${codes}. Refresh the page and pick current services.`,
    };
  }

  // Active rows from the admin-managed discount catalog. Codes not in this
  // list (retired, or garbage from a stale client) fall back to no discount.
  const { data: discountRows } = await supabase
    .from("discount_types")
    .select("code, label, kind, percent, amount_php, is_statutory")
    .eq("active", true);
  const discountByCode = new Map(
    (discountRows ?? []).map((d) => [
      d.code,
      {
        code: d.code,
        label: d.label,
        kind: d.kind as "percent" | "fixed" | "custom",
        percent: d.percent != null ? Number(d.percent) : null,
        amount_php: d.amount_php != null ? Number(d.amount_php) : null,
        is_statutory: d.is_statutory,
      },
    ]),
  );

  // The doctor-fee split depends on the attending physician's compensation
  // arrangement (rent_paying / shareholder → clinic keeps ₱0; pf_split → ₱100)
  // — or their per-doctor clinic_cut_php override when one is configured.
  let attendingArrangement: string | null = null;
  let attendingClinicCutPhp: number | null = null;
  if (parsed.data.attending_physician_id) {
    // 0136 moved these off `physicians`, which is public-read. The side table
    // has no anon grant and an admin-only policy, so this stays on the admin
    // client — as it already was.
    const physAdmin = createAdminClient();
    const { data: comp } = await physAdmin
      .from("physician_compensation")
      .select("compensation_arrangement, clinic_cut_php")
      .eq("physician_id", parsed.data.attending_physician_id)
      .maybeSingle();
    attendingArrangement = comp?.compensation_arrangement ?? null;
    attendingClinicCutPhp = comp?.clinic_cut_php != null ? Number(comp.clinic_cut_php) : null;
  }

  // Snapshot pricing per line — same arithmetic as the client form so the
  // server is the source of truth even if the client sent stale values.
  const doctorHmoSelected = parsed.data.doctor_hmo_provider_id !== null;
  const labHmoSelected = parsed.data.lab_hmo_provider_id !== null;
  const lines = parsed.data.service_ids.map((service_id) => {
    const s = services.find((x) => x.id === service_id)!;
    const cashPrice = Number(s.price_php);
    const hmoPrice = s.hmo_price_php != null ? Number(s.hmo_price_php) : null;

    // Both doctor kinds are priced at the counter, not from the catalog
    // (item 3). doctorLineBase owns the blank-box rule: a blank consult is ₱0
    // (rejected below), a blank procedure falls back to its catalog price.
    const typedFeeRaw =
      s.kind === "doctor_consultation"
        ? formData.get(`consult_fee__${service_id}`)?.toString() ?? ""
        : s.kind === "doctor_procedure"
          ? formData.get(`procedure_fee__${service_id}`)?.toString() ?? ""
          : "";
    const lineHmoSelected = isDoctorKind(s.kind) ? doctorHmoSelected : labHmoSelected;
    const catalogPrice =
      lineHmoSelected && hmoPrice != null ? hmoPrice : cashPrice;
    const base = doctorLineBase({
      kind: s.kind,
      typedRaw: typedFeeRaw,
      catalogPrice,
    });

    // Discount codes come from the admin-managed discount_types catalog;
    // anything not in the active list (retired code, stale client) means no
    // discount. The server recomputes the amount from the catalog rate — and
    // a statutory Senior/PWD code posted against an ineligible service (e.g.
    // a lab package, from a crafted or stale client) is dropped entirely so
    // the line records no discount kind, not a ₱0 senior discount.
    const rawKind = formData.get(`discount_kind__${service_id}`)?.toString() ?? "";
    const posted = discountByCode.get(rawKind) ?? null;
    const discountType =
      posted?.is_statutory && !isSeniorPwdEligible(s) ? null : posted;
    const discount_kind = discountType?.code ?? null;
    const discount_amount_php = lineDiscount({
      discountType,
      base,
      customRaw: formData.get(`custom_discount__${service_id}`)?.toString() ?? "",
      seniorPwdEligible: isSeniorPwdEligible(s),
    });

    const final_price_php = Math.max(0, base - discount_amount_php);

    // Doctor consultation: capture clinic_fee + doctor_pf split. The split is
    // centralized in splitDoctorFee, which defaults clinic_fee from the
    // physician's arrangement and PF to the remainder when inputs are empty.
    let clinic_fee_php: number | null = null;
    let doctor_pf_php: number | null = null;
    if (s.kind === "doctor_consultation") {
      const split = splitDoctorFee({
        finalPrice: final_price_php,
        arrangement: attendingArrangement,
        clinicFeeRaw: formData.get(`clinic_fee__${service_id}`)?.toString() ?? "",
        doctorPfRaw: formData.get(`doctor_pf__${service_id}`)?.toString() ?? "",
        clinicCutPhp: attendingClinicCutPhp,
      });
      clinic_fee_php = split.clinic_fee_php;
      doctor_pf_php = split.doctor_pf_php;
    }

    // Doctor procedure: capture description + post-approval HMO grant + clinic fee + doctor PF.
    let procedure_description: string | null = null;
    let hmo_approved_amount_php: number | null = null;
    if (s.kind === "doctor_procedure") {
      const desc = formData.get(`procedure_description__${service_id}`)?.toString().trim() ?? "";
      procedure_description = desc.length > 0 ? desc : null;
      const apRaw = formData.get(`hmo_approved_amount__${service_id}`)?.toString() ?? "";
      const apNum = Number(apRaw);
      hmo_approved_amount_php =
        apRaw !== "" && Number.isFinite(apNum) && apNum >= 0 ? apNum : null;
      // Procedure lines mirror consult lines: capture clinic_fee + doctor_pf
      // split. Procedures default clinic fee to ₱0 unless reception types one;
      // PF is the remainder. (defaultClinicFee handles rent/shareholder = 0 too.)
      const cfRaw = formData.get(`clinic_fee__${service_id}`)?.toString() ?? "";
      const split = splitDoctorFee({
        finalPrice: final_price_php,
        arrangement: attendingArrangement,
        clinicFeeRaw: cfRaw.trim() === "" ? "0" : cfRaw,
        doctorPfRaw: formData.get(`doctor_pf__${service_id}`)?.toString() ?? "",
      });
      clinic_fee_php = split.clinic_fee_php;
      doctor_pf_php = split.doctor_pf_php;
    }

    return {
      service_id,
      kind: s.kind,
      base_price_php: base,
      discount_kind,
      discount_amount_php,
      final_price_php,
      clinic_fee_php,
      doctor_pf_php,
      procedure_description,
      hmo_approved_amount_php,
    };
  });

  // A consultation must have a positive (manual) fee and an attending physician
  // — release later requires the physician (P0034), and a ₱0 consult is a slip.
  const consultLines = lines.filter((l) => l.kind === "doctor_consultation");
  if (consultLines.length > 0) {
    if (!parsed.data.attending_physician_id) {
      return { ok: false, error: "Select an attending physician for the consultation." };
    }
    if (consultLines.some((l) => !(l.final_price_php > 0))) {
      return { ok: false, error: "Enter a consultation fee greater than ₱0." };
    }
  }

  // Procedures are counter-priced too (item 3), so the same ₱0 slip is
  // possible. The physician check is narrower than the consult one: a
  // procedure that pays the doctor nothing (fully absorbed by the clinic)
  // needs no attending physician, but PF that accrues to nobody is money the
  // clinic can never pay out.
  const procedureLines = lines.filter((l) => l.kind === "doctor_procedure");
  if (procedureLines.length > 0) {
    if (procedureLines.some((l) => !(l.final_price_php > 0))) {
      return { ok: false, error: "Enter a procedure fee greater than ₱0." };
    }
    if (
      !parsed.data.attending_physician_id &&
      procedureLines.some((l) => (l.doctor_pf_php ?? 0) > 0)
    ) {
      return {
        ok: false,
        error: "Select an attending physician for the procedure, or set its doctor PF to ₱0.",
      };
    }
  }

  // Partition the order into the two billing categories.
  const { doctor: doctorLines, lab: labLines } = partitionByCategory(
    lines,
    (l) => l.kind,
  );
  const split = doctorLines.length > 0 && labLines.length > 0;

  const doctorHmo: VisitHmo = {
    hmo_provider_id: parsed.data.doctor_hmo_provider_id,
    hmo_approval_date: parsed.data.doctor_hmo_approval_date,
    hmo_authorization_no: parsed.data.doctor_hmo_authorization_no,
  };
  const labHmo: VisitHmo = {
    hmo_provider_id: parsed.data.lab_hmo_provider_id,
    hmo_approval_date: parsed.data.lab_hmo_approval_date,
    hmo_authorization_no: parsed.data.lab_hmo_authorization_no,
  };

  const servicesForDecomp = services.map((s) => ({
    id: s.id,
    kind: s.kind,
    code: s.code,
    name: s.name,
  }));

  // crypto.randomUUID is available in the Node runtime.
  const groupId = split ? crypto.randomUUID() : null;

  // One visit, or two sharing groupId (doctor half first, then lab half).
  const visitSpecs = split
    ? [
        { lines: doctorLines, hmo: doctorHmo, attendingPhysicianId: parsed.data.attending_physician_id ?? null },
        { lines: labLines, hmo: labHmo, attendingPhysicianId: null },
      ]
    : [
        {
          lines,
          hmo: doctorLines.length > 0 ? doctorHmo : labHmo,
          attendingPhysicianId: doctorLines.length > 0 ? parsed.data.attending_physician_id ?? null : null,
        },
      ];

  // Pure reads first — a misconfigured package aborts with nothing written.
  const payloads: EncounterVisitPayload[] = [];
  for (const spec of visitSpecs) {
    const decomp = await loadPackageDecompositionsForLines(supabase, spec.lines, servicesForDecomp);
    if (!decomp.ok) return { ok: false, error: decomp.error };
    const built = buildEncounterVisit(
      {
        lines: spec.lines,
        decompositions: decomp.decompositions,
        hmo: spec.hmo,
        attendingPhysicianId: spec.attendingPhysicianId,
        receptionistRemarks: parsed.data.receptionist_remarks,
        notes: parsed.data.notes ?? null,
        isSample: parsed.data.is_sample,
      },
      () => crypto.randomUUID(),
    );
    if (!built.ok) return { ok: false, error: built.error };
    payloads.push(built.payload);
  }

  // One PIN for the whole encounter (portal login is per patient); only its
  // bcrypt hash leaves this function. The plain PIN is shown once below.
  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();

  // 0184: visit(s), every line, the PIN rows, the pre-registration clear and
  // the audit rows in ONE transaction under the patient's lifecycle lock —
  // no half-created visit to clean up any more.
  const { data: encounter, error: encErr } = await withLifecycleRetry(() =>
    admin.rpc("create_visit_encounter", {
      p_actor: session.user_id,
      p_patient_id: parsed.data.patient_id,
      p_pin_hash: pinHash,
      p_visits: payloads as unknown as Json,
      p_visit_group_id: groupId ?? undefined,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (encErr || !encounter) {
    return { ok: false, error: translatePgError(encErr ?? { message: "Could not create the visit." }) };
  }
  const created = (encounter as { visits: { id: string; visit_number: string }[] }).visits.map((v) => ({
    visitId: v.id,
    visitNumber: v.visit_number,
  }));

  // Patient Sources (spec §3.7): reception answered "How did you hear about
  // us?" for a patient with no source yet. Conditional on it still being empty,
  // so a value set meanwhile is never overwritten. RLS client with no
  // app.referral_origin → 0170's trigger records origin 'staff'. Optional:
  // a failure here never undoes the visit.
  const referralAnswer = parseReferralAnswer(formData.get("referral_source"));
  if (referralAnswer) {
    const { data: sourced, error: sourceErr } = await supabase
      .from("patients")
      .update({ referral_source: referralAnswer })
      .eq("id", parsed.data.patient_id)
      .is("referral_source", null)
      .select("id");
    if (sourceErr) {
      console.error("[visits/new] referral source not saved", sourceErr.code);
    } else if (sourced && sourced.length > 0) {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: parsed.data.patient_id,
        action: "patient.referral_source_recorded",
        resource_type: "patient",
        resource_id: parsed.data.patient_id,
        metadata: { referral_source: referralAnswer, via: "new_visit" },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  // Close the loop on the appointment this visit was started from, if any.
  // The visit (and its PIN) already exist above, so this is strictly
  // best-effort: a failure (wrong role, appointment no longer "arrived", a
  // stale/bad id) must never roll back the visit or surface an error to
  // reception here — swallow it and let the redirect below proceed either
  // way. Walk-ins never send appointment_id, so this is a no-op for them.
  if (parsed.data.appointment_id) {
    try {
      const result = await completeAppointmentFromVisitAction(
        parsed.data.appointment_id,
        created[0]!.visitId,
        groupId,
      );
      if (!result.ok) {
        console.error("completeAppointmentFromVisitAction failed", result.error);
      }
    } catch (err) {
      console.error("completeAppointmentFromVisitAction threw", err);
    }
  } else if (parsed.data.patient_id) {
    // A9/L1 fallback: reception can also start the visit straight from the
    // patient's page, which threads no appointment_id at all. That was the
    // documented workaround while "Mark arrived" hid walk-ins from every
    // section, and it left the appointment dangling at "arrived" forever
    // even though the visit existed. Close out any arrived appointment this
    // patient still has, by patient_id rather than by appointment id.
    //
    // Finding 9: pass the visit's own service_ids through so only arrived
    // appointments for services THIS visit actually covers get completed —
    // a patient arrived for an unrelated doctor consultation must not be
    // swept just because a lab visit was started from their patient page.
    // See completeArrivedAppointmentsForPatientAction's own comment for the
    // full rationale and the visit/patient pairing check it now does.
    //
    // Same best-effort contract as the branch above, and deliberately an
    // `else` — when an appointment_id was supplied it has already completed
    // the whole booking group, so running this too would be redundant.
    // "No arrived appointment for this patient" is the ordinary case for a
    // true walk-off-the-street visit (or one whose arrived appointments are
    // all for other services), so it is not logged as a failure.
    try {
      const result = await completeArrivedAppointmentsForPatientAction(
        parsed.data.patient_id,
        created[0]!.visitId,
        parsed.data.service_ids,
        groupId,
      );
      if (!result.ok && result.error !== "No arrived appointment for this patient.") {
        console.error("completeArrivedAppointmentsForPatientAction failed", result.error);
      }
    } catch (err) {
      console.error("completeArrivedAppointmentsForPatientAction threw", err);
    }
  }

  if (split && groupId) {
    // A split order always has a lab half, so the combined receipt still
    // prints (and still carries the PIN) — the group page suppresses just the
    // consultation-only doctor slip.
    await setVisitPinFlash({ group_id: groupId, pin: plainPin });
    redirect(`/staff/visits/group/${groupId}/receipt`);
  }

  // Item 1 / decision 4: a consultation-only visit prints nothing. Skip the
  // PIN flash too — with no slip to print it on, the plain PIN would sit in a
  // cookie no one ever reads. The visit_pins row stands, so admin can still
  // re-issue if lab work is added to this patient later.
  if (isConsultOnlyOrder(lines.map((l) => l.kind))) {
    redirect(`/staff/visits/${created[0]!.visitId}?created=consult`);
  }

  await setVisitPinFlash({ visit_id: created[0]!.visitId, pin: plainPin });
  redirect(`/staff/visits/${created[0]!.visitId}/receipt`);
}

// ---------------------------------------------------------------------------
// Split-visit orchestration helpers.

interface VisitHmo {
  hmo_provider_id: string | null;
  hmo_approval_date: string | null;
  hmo_authorization_no: string | null;
}

// ---------------------------------------------------------------------------
// Phase 14: package decomposition helpers + Server Action.

// Same shape create_visit_encounter's payload wants (0184) — reuse the
// builder's type rather than a parallel local one.
type PackageDecomposition = EncounterDecomposition;

async function loadPackageDecompositionsForLines(
  supabase: SupabaseClient<Database>,
  lines: Array<{ service_id: string }>,
  services: Array<{ id: string; kind: string; code: string; name: string }>,
): Promise<
  | { ok: true; decompositions: PackageDecomposition[] }
  | { ok: false; error: string }
> {
  const packageLines = lines.filter((l) => {
    const svc = services.find((s) => s.id === l.service_id);
    return svc?.kind === "lab_package";
  });
  if (packageLines.length === 0) {
    return { ok: true, decompositions: [] };
  }

  const decompositions: PackageDecomposition[] = [];
  for (const line of packageLines) {
    const pkgService = services.find((s) => s.id === line.service_id);
    const { data, error } = await supabase
      .from("package_components")
      .select(
        `component_service_id,
         sort_order,
         services:services!package_components_component_service_id_fkey ( id, code, name, is_active )`,
      )
      .eq("package_service_id", line.service_id)
      .order("sort_order");
    if (error) {
      return {
        ok: false,
        error: `Failed to load components for package ${pkgService?.code ?? line.service_id}: ${error.message}`,
      };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        error: `Package ${pkgService?.name ?? "(unknown)"} has no components configured. Contact admin to set up its composition.`,
      };
    }
    const inactive = data.filter(
      (r) =>
        r.services != null &&
        !Array.isArray(r.services) &&
        r.services.is_active === false,
    );
    if (inactive.length > 0) {
      const codes = inactive
        .map((r) =>
          r.services != null && !Array.isArray(r.services)
            ? r.services.code
            : null,
        )
        .filter(Boolean)
        .join(", ");
      return {
        ok: false,
        error: `Package contains inactive components: ${codes}. Contact admin to update its composition.`,
      };
    }
    decompositions.push({
      headerLine: { service_id: line.service_id },
      componentServiceIds: data.map((r) => r.component_service_id),
    });
  }
  return { ok: true, decompositions };
}

export type PackageComponentsResult =
  | {
      ok: true;
      components: Array<{
        component_service_id: string;
        sort_order: number;
        component_code: string;
        component_name: string;
        component_section: string | null;
      }>;
    }
  | { ok: false; error: string };

export async function getPackageComponentsAction(
  packageServiceId: string,
): Promise<PackageComponentsResult> {
  // Auth gate — only signed-in staff use this lookup (the form is staff-only).
  await requireActiveStaff();

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("package_components")
    .select(
      `component_service_id,
       sort_order,
       services:services!package_components_component_service_id_fkey (
         code,
         name,
         section,
         is_active
       )`,
    )
    .eq("package_service_id", packageServiceId)
    .order("sort_order");

  if (error) {
    return {
      ok: false,
      error: `Failed to load package components: ${error.message}`,
    };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        "This package has no components configured. Contact admin to set up its composition.",
    };
  }

  // Surface inactive components as a hard error — they'd block order time anyway.
  const inactive = data.filter(
    (r) =>
      r.services != null &&
      !Array.isArray(r.services) &&
      r.services.is_active === false,
  );
  if (inactive.length > 0) {
    const codes = inactive
      .map((r) =>
        r.services != null && !Array.isArray(r.services)
          ? r.services.code
          : null,
      )
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      error: `Package contains inactive components: ${codes}`,
    };
  }

  return {
    ok: true,
    components: data.map((r) => {
      const svc =
        r.services != null && !Array.isArray(r.services) ? r.services : null;
      return {
        component_service_id: r.component_service_id,
        sort_order: r.sort_order,
        component_code: svc?.code ?? "(unknown)",
        component_name: svc?.name ?? "(unknown)",
        component_section: svc?.section ?? null,
      };
    }),
  };
}
