"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { generatePin, hashPin } from "@/lib/auth/pin";
import { setVisitPinFlash } from "@/lib/auth/visit-pin-flash";
import { splitDoctorFee } from "@/lib/visits/consultation-fee";
import { isDoctorKind, partitionByCategory } from "@/lib/visits/order-lines";
import { isSeniorPwdEligible, seniorPwdDiscount } from "@/lib/pricing/senior";
import type { Database } from "@/types/database";

const DiscountKindEnum = z.enum([
  "senior_pwd_20",
  "pct_10",
  "pct_5",
  "other_pct_20",
  "custom",
]);

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
});

export type CreateVisitResult =
  | { ok: true; visit_id: string }
  | { ok: false; error: string };

export async function createVisitAction(
  _prev: CreateVisitResult | null,
  formData: FormData,
): Promise<CreateVisitResult> {
  const session = await requireActiveStaff();

  const parsed = Schema.safeParse({
    patient_id: formData.get("patient_id"),
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
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();

  const { data: services, error: svcErr } = await supabase
    .from("services")
    .select(
      "id, kind, code, name, price_php, hmo_price_php, senior_discount_php, senior_pwd_eligible",
    )
    .in("id", parsed.data.service_ids);

  if (svcErr || !services || services.length !== parsed.data.service_ids.length) {
    return { ok: false, error: "One or more services could not be found." };
  }

  // The doctor-fee split depends on the attending physician's compensation
  // arrangement (rent_paying / shareholder → clinic keeps ₱0; pf_split → ₱100).
  let attendingArrangement: string | null = null;
  if (parsed.data.attending_physician_id) {
    const physAdmin = createAdminClient();
    const { data: phys } = await physAdmin
      .from("physicians")
      .select("compensation_arrangement")
      .eq("id", parsed.data.attending_physician_id)
      .maybeSingle();
    attendingArrangement = phys?.compensation_arrangement ?? null;
  }

  // Snapshot pricing per line — same arithmetic as the client form so the
  // server is the source of truth even if the client sent stale values.
  const doctorHmoSelected = parsed.data.doctor_hmo_provider_id !== null;
  const labHmoSelected = parsed.data.lab_hmo_provider_id !== null;
  const lines = parsed.data.service_ids.map((service_id) => {
    const s = services.find((x) => x.id === service_id)!;
    const cashPrice = Number(s.price_php);
    const hmoPrice = s.hmo_price_php != null ? Number(s.hmo_price_php) : null;
    const seniorPesoOff =
      s.senior_discount_php != null ? Number(s.senior_discount_php) : null;

    // doctor_consultation: price is typed at the counter, not from the catalog.
    const consultFeeRaw =
      s.kind === "doctor_consultation"
        ? formData.get(`consult_fee__${service_id}`)?.toString() ?? ""
        : "";
    const consultFee = Number(consultFeeRaw);
    const lineHmoSelected = isDoctorKind(s.kind) ? doctorHmoSelected : labHmoSelected;
    const base =
      s.kind === "doctor_consultation"
        ? Number.isFinite(consultFee) && consultFee >= 0
          ? consultFee
          : 0
        : lineHmoSelected && hmoPrice != null
          ? hmoPrice
          : cashPrice;

    const rawKind = formData.get(`discount_kind__${service_id}`)?.toString() ?? "";
    const parsedKind = DiscountKindEnum.safeParse(rawKind);
    const discount_kind = parsedKind.success ? parsedKind.data : null;

    let discount_amount_php = 0;
    if (discount_kind === "senior_pwd_20") {
      // Source of truth for senior/PWD eligibility: ineligible services
      // (e.g. lab packages) get 0 even if a stale client posted the discount.
      discount_amount_php = seniorPwdDiscount({
        base,
        seniorDiscountPhp: seniorPesoOff,
        eligible: isSeniorPwdEligible(s),
      });
    } else if (discount_kind === "pct_10") {
      discount_amount_php = Math.round(base * 0.1 * 100) / 100;
    } else if (discount_kind === "pct_5") {
      discount_amount_php = Math.round(base * 0.05 * 100) / 100;
    } else if (discount_kind === "other_pct_20") {
      discount_amount_php = Math.round(base * 0.2 * 100) / 100;
    } else if (discount_kind === "custom") {
      const raw = formData.get(`custom_discount__${service_id}`)?.toString() ?? "";
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) {
        discount_amount_php = Math.min(n, base);
      }
    }

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
      // Procedure lines mirror consult lines: capture clinic_fee + doctor_pf split.
      // Default clinic_fee=0 for procedures unless the form sends a value.
      if (clinic_fee_php === null) {
        // Procedures default clinic fee to 0 unless reception types one; PF is
        // the remainder. (defaultClinicFee handles rent/shareholder = 0 too.)
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
  const hasConsult = lines.some(
    (l) => services.find((s) => s.id === l.service_id)?.kind === "doctor_consultation",
  );
  if (hasConsult) {
    if (!parsed.data.attending_physician_id) {
      return { ok: false, error: "Select an attending physician for the consultation." };
    }
    const badConsult = lines.some(
      (l) =>
        services.find((s) => s.id === l.service_id)?.kind === "doctor_consultation" &&
        !(l.final_price_php > 0),
    );
    if (badConsult) {
      return { ok: false, error: "Enter a consultation fee greater than ₱0." };
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

  const created: OneVisitResult[] = [];
  try {
    if (split) {
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: doctorLines,
          services: servicesForDecomp,
          hmo: doctorHmo,
          attendingPhysicianId: parsed.data.attending_physician_id ?? null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: groupId,
        }),
      );
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: labLines,
          services: servicesForDecomp,
          hmo: labHmo,
          attendingPhysicianId: null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: groupId,
        }),
      );
    } else {
      const onlyDoctor = doctorLines.length > 0;
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: lines,
          services: servicesForDecomp,
          hmo: onlyDoctor ? doctorHmo : labHmo,
          attendingPhysicianId: onlyDoctor
            ? parsed.data.attending_physician_id ?? null
            : null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: null,
        }),
      );
    }
  } catch (err) {
    for (const c of created) await deleteVisitCascade(supabase, c.visitId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not create visit.",
    };
  }

  // One shared PIN across all created visits (portal is per-patient; login
  // matches the latest pin row). Same hash + expiry on every visit_pins row.
  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const admin = createAdminClient();
  const { error: pinErr } = await admin
    .from("visit_pins")
    .insert(created.map((c) => ({ visit_id: c.visitId, pin_hash: pinHash })));
  if (pinErr) {
    for (const c of created) await deleteVisitCascade(supabase, c.visitId);
    return { ok: false, error: `Visit created but PIN failed: ${pinErr.message}` };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  for (const c of created) {
    const visitLines = split
      ? c.visitId === created[0]!.visitId
        ? doctorLines
        : labLines
      : lines;
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: parsed.data.patient_id,
      action: "visit.created",
      resource_type: "visit",
      resource_id: c.visitId,
      metadata: {
        visit_number: c.visitNumber,
        total_php: visitLines.reduce((s, l) => s + l.final_price_php, 0),
        service_count: visitLines.length,
        visit_group_id: groupId,
        hmo_provider_id: c.hmo.hmo_provider_id,
        discounted_lines: visitLines.filter((l) => l.discount_amount_php > 0).length,
      },
      ip_address: ip,
      user_agent: ua,
    });

    for (let i = 0; i < c.decompositions.length; i++) {
      const d = c.decompositions[i]!;
      const pkgService = services.find((s) => s.id === d.headerLine.service_id);
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: parsed.data.patient_id,
        action: "package.decomposed",
        resource_type: "test_request",
        resource_id: c.headerIdsForAudit[i] ?? null,
        metadata: {
          visit_id: c.visitId,
          package_service_id: d.headerLine.service_id,
          package_code: pkgService?.code ?? null,
          package_name: pkgService?.name ?? null,
          component_count: d.componentServiceIds.length,
          component_service_ids: d.componentServiceIds,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  if (split && groupId) {
    await setVisitPinFlash({ group_id: groupId, pin: plainPin });
    redirect(`/staff/visits/group/${groupId}/receipt`);
  } else {
    await setVisitPinFlash({ visit_id: created[0]!.visitId, pin: plainPin });
    redirect(`/staff/visits/${created[0]!.visitId}/receipt`);
  }
}

// ---------------------------------------------------------------------------
// Split-visit orchestration helpers.

interface VisitHmo {
  hmo_provider_id: string | null;
  hmo_approval_date: string | null;
  hmo_authorization_no: string | null;
}

interface OneVisitInput {
  patientId: string;
  createdBy: string;
  lines: Array<{
    service_id: string;
    kind: string;
    base_price_php: number;
    discount_kind: string | null;
    discount_amount_php: number;
    final_price_php: number;
    clinic_fee_php: number | null;
    doctor_pf_php: number | null;
    procedure_description: string | null;
    hmo_approved_amount_php: number | null;
  }>;
  services: Array<{ id: string; kind: string; code: string; name: string }>;
  hmo: VisitHmo;
  attendingPhysicianId: string | null;
  receptionistRemarks: string | null;
  notes: string | null;
  visitGroupId: string | null;
}

interface OneVisitResult {
  visitId: string;
  visitNumber: string;
  hmo: VisitHmo;
  decompositions: PackageDecomposition[];
  headerIdsForAudit: Array<string | null>;
}

// Creates a single visit and all its test_requests (incl. package
// decomposition). Throws Error on any failure; the caller rolls back.
async function createOneVisit(
  supabase: SupabaseClient<Database>,
  input: OneVisitInput,
): Promise<OneVisitResult> {
  const totalPhp = input.lines.reduce((sum, l) => sum + l.final_price_php, 0);

  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .insert({
      patient_id: input.patientId,
      total_php: totalPhp,
      notes: input.notes,
      created_by: input.createdBy,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      attending_physician_id: input.attendingPhysicianId,
      visit_group_id: input.visitGroupId,
    })
    .select("id, visit_number")
    .single();
  if (visitErr || !visit) {
    throw new Error(visitErr?.message ?? "Could not create visit.");
  }

  const decompositionResult = await loadPackageDecompositionsForLines(
    supabase,
    input.lines,
    input.services,
  );
  if (!decompositionResult.ok) {
    await deleteVisitCascade(supabase, visit.id);
    throw new Error(decompositionResult.error);
  }
  const decompositions = decompositionResult.decompositions;
  const packageServiceIds = new Set(decompositions.map((d) => d.headerLine.service_id));

  const headerRows = input.lines
    .filter((l) => packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: input.createdBy,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      receptionist_remarks: input.receptionistRemarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: true as const,
      status: "in_progress" as const,
    }));

  const standaloneRows = input.lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: input.createdBy,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      receptionist_remarks: input.receptionistRemarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: false as const,
    }));

  const headerRowsBySvcId = new Map<string, string[]>();
  if (headerRows.length > 0) {
    const headerInserts = await supabase
      .from("test_requests")
      .insert(headerRows)
      .select("id, service_id");
    if (headerInserts.error || !headerInserts.data) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Failed to create package header rows: ${headerInserts.error?.message}`);
    }
    for (const row of headerInserts.data) {
      const arr = headerRowsBySvcId.get(row.service_id) ?? [];
      arr.push(row.id);
      headerRowsBySvcId.set(row.service_id, arr);
    }
  }

  const headerIdsForAudit: Array<string | null> = [];
  // Same explicit shape the original action used, so the mixed
  // [...standaloneRows, ...componentRows] insert keeps type-checking.
  const componentRows: Array<{
    visit_id: string;
    service_id: string;
    requested_by: string;
    base_price_php: number;
    discount_amount_php: number;
    final_price_php: number;
    hmo_provider_id: string | null;
    hmo_approval_date: string | null;
    hmo_authorization_no: string | null;
    parent_id: string;
    is_package_header: false;
  }> = [];
  for (const d of decompositions) {
    const headerIdQueue = headerRowsBySvcId.get(d.headerLine.service_id) ?? [];
    const headerId = headerIdQueue.shift();
    if (!headerId) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Internal error: missing header row for service ${d.headerLine.service_id}`);
    }
    headerRowsBySvcId.set(d.headerLine.service_id, headerIdQueue);
    headerIdsForAudit.push(headerId);
    for (const componentServiceId of d.componentServiceIds) {
      componentRows.push({
        visit_id: visit.id,
        service_id: componentServiceId,
        requested_by: input.createdBy,
        base_price_php: 0,
        discount_amount_php: 0,
        final_price_php: 0,
        hmo_provider_id: input.hmo.hmo_provider_id,
        hmo_approval_date: input.hmo.hmo_approval_date,
        hmo_authorization_no: input.hmo.hmo_authorization_no,
        parent_id: headerId,
        is_package_header: false,
      });
    }
  }

  const allLeafRows = [...standaloneRows, ...componentRows];
  if (allLeafRows.length > 0) {
    const { error: leafErr } = await supabase.from("test_requests").insert(allLeafRows);
    if (leafErr) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Visit created but tests failed: ${leafErr.message}`);
    }
  }

  return {
    visitId: visit.id,
    visitNumber: visit.visit_number,
    hmo: input.hmo,
    decompositions,
    headerIdsForAudit,
  };
}

// Best-effort cleanup. test_requests.visit_id has NO on-delete-cascade, so
// delete the lines first; visit_pins DOES cascade with the visit.
async function deleteVisitCascade(
  supabase: SupabaseClient<Database>,
  visitId: string,
): Promise<void> {
  await supabase.from("test_requests").delete().eq("visit_id", visitId);
  await supabase.from("visits").delete().eq("id", visitId);
}

// ---------------------------------------------------------------------------
// Phase 14: package decomposition helpers + Server Action.

interface PackageDecomposition {
  // The original line (used to identify which header to attach components to)
  headerLine: { service_id: string };
  // Component service IDs in sort order
  componentServiceIds: string[];
}

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
