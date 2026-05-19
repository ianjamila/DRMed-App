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
  hmo_provider_id: optionalUuid,
  hmo_approval_date: optionalDate,
  hmo_authorization_no: optionalText(80),
  receptionist_remarks: optionalText(40),
  notes: z.string().trim().max(2000).optional(),
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
    hmo_provider_id: formData.get("hmo_provider_id"),
    hmo_approval_date: formData.get("hmo_approval_date"),
    hmo_authorization_no: formData.get("hmo_authorization_no"),
    receptionist_remarks: formData.get("receptionist_remarks"),
    notes: formData.get("notes") ?? "",
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
    .select("id, kind, code, name, price_php, hmo_price_php, senior_discount_php")
    .in("id", parsed.data.service_ids);

  if (svcErr || !services || services.length !== parsed.data.service_ids.length) {
    return { ok: false, error: "One or more services could not be found." };
  }

  // Snapshot pricing per line — same arithmetic as the client form so the
  // server is the source of truth even if the client sent stale values.
  const hmoSelected = parsed.data.hmo_provider_id !== null;
  const lines = parsed.data.service_ids.map((service_id) => {
    const s = services.find((x) => x.id === service_id)!;
    const cashPrice = Number(s.price_php);
    const hmoPrice = s.hmo_price_php != null ? Number(s.hmo_price_php) : null;
    const seniorPesoOff =
      s.senior_discount_php != null ? Number(s.senior_discount_php) : null;

    const base = hmoSelected && hmoPrice != null ? hmoPrice : cashPrice;

    const rawKind = formData.get(`discount_kind__${service_id}`)?.toString() ?? "";
    const parsedKind = DiscountKindEnum.safeParse(rawKind);
    const discount_kind = parsedKind.success ? parsedKind.data : null;

    let discount_amount_php = 0;
    if (discount_kind === "senior_pwd_20") {
      discount_amount_php =
        seniorPesoOff != null
          ? Math.min(seniorPesoOff, base)
          : Math.round(base * 0.2 * 100) / 100;
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

    // Doctor consultation: capture clinic_fee + doctor_pf split. Default to
    // clinic_fee=100 and doctor_pf=final-100 when reception leaves the
    // inputs empty.
    let clinic_fee_php: number | null = null;
    let doctor_pf_php: number | null = null;
    if (s.kind === "doctor_consultation") {
      const cfRaw = formData.get(`clinic_fee__${service_id}`)?.toString() ?? "";
      const cfNum = cfRaw === "" ? 100 : Number(cfRaw);
      clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : 100;
      const pfRaw = formData.get(`doctor_pf__${service_id}`)?.toString() ?? "";
      const pfDefault = Math.max(0, final_price_php - clinic_fee_php);
      const pfNum = pfRaw === "" ? pfDefault : Number(pfRaw);
      doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;
    }

    // Doctor procedure: capture description + post-approval HMO grant.
    let procedure_description: string | null = null;
    let hmo_approved_amount_php: number | null = null;
    if (s.kind === "doctor_procedure") {
      const desc = formData.get(`procedure_description__${service_id}`)?.toString().trim() ?? "";
      procedure_description = desc.length > 0 ? desc : null;
      const apRaw = formData.get(`hmo_approved_amount__${service_id}`)?.toString() ?? "";
      const apNum = Number(apRaw);
      hmo_approved_amount_php =
        apRaw !== "" && Number.isFinite(apNum) && apNum >= 0 ? apNum : null;
    }

    return {
      service_id,
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

  const totalPhp = lines.reduce((sum, l) => sum + l.final_price_php, 0);

  // Create the visit, including the HMO authorisation if provided.
  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .insert({
      patient_id: parsed.data.patient_id,
      total_php: totalPhp,
      notes: parsed.data.notes ?? null,
      created_by: session.user_id,
      hmo_provider_id: parsed.data.hmo_provider_id,
      hmo_approval_date: parsed.data.hmo_approval_date,
      hmo_authorization_no: parsed.data.hmo_authorization_no,
    })
    .select("id, visit_number")
    .single();

  if (visitErr || !visit) {
    return { ok: false, error: visitErr?.message ?? "Could not create visit." };
  }

  // Phase 14: lab_package services decompose into a billing header +
  // N component test_requests. Load each package's components from
  // package_components and build header/component rows. Non-package
  // lines insert as single rows (existing behaviour).
  const decompositionResult = await loadPackageDecompositionsForLines(
    supabase,
    lines,
    services,
  );
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decompositions = decompositionResult.decompositions;
  const packageServiceIds = new Set(
    decompositions.map((d) => d.headerLine.service_id),
  );

  // Header rows: one per package line, carries full pricing + HMO metadata.
  // The fn_header_auto_promote trigger flips status from in_progress to
  // ready_for_release on insert.
  const headerRows = lines
    .filter((l) => packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: session.user_id,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: parsed.data.hmo_provider_id,
      hmo_approval_date: parsed.data.hmo_approval_date,
      hmo_authorization_no: parsed.data.hmo_authorization_no,
      receptionist_remarks: parsed.data.receptionist_remarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: true as const,
      // Headers carry no work — the 0040 fn_header_auto_promote trigger
      // flips this to 'ready_for_release' on insert so the row stays out
      // of every queue and waits for the 12.2 payment-gating trigger to
      // release it when the visit is paid.
      status: "in_progress" as const,
    }));

  // Standalone rows: existing non-package services (unchanged shape).
  const standaloneRows = lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: session.user_id,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: parsed.data.hmo_provider_id,
      hmo_approval_date: parsed.data.hmo_approval_date,
      hmo_authorization_no: parsed.data.hmo_authorization_no,
      receptionist_remarks: parsed.data.receptionist_remarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
    }));

  // Insert headers first (we need their ids to populate parent_id on components).
  const headerRowsBySvcId = new Map<string, string[]>();
  if (headerRows.length > 0) {
    const headerInserts = await supabase
      .from("test_requests")
      .insert(headerRows)
      .select("id, service_id");
    if (headerInserts.error || !headerInserts.data) {
      return {
        ok: false,
        error: `Failed to create package header rows: ${headerInserts.error?.message}`,
      };
    }
    // service_id may repeat across multiple package lines, but the same
    // package can be ordered twice — keep one queue per service id and pop
    // a fresh header per decomposition entry.
    for (const row of headerInserts.data) {
      const arr = headerRowsBySvcId.get(row.service_id) ?? [];
      arr.push(row.id);
      headerRowsBySvcId.set(row.service_id, arr);
    }
  }

  // Build component rows, attaching each to the correct header by service_id.
  // If a package is ordered N times in the same visit, round-robin the
  // component rows to each header (one batch of components per header).
  // Track which header was used by each decomposition for the audit row.
  const headerIdsForAudit: Array<string | null> = [];
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
      return {
        ok: false,
        error: `Internal error: missing header row for service ${d.headerLine.service_id}`,
      };
    }
    headerRowsBySvcId.set(d.headerLine.service_id, headerIdQueue);
    headerIdsForAudit.push(headerId);
    for (const componentServiceId of d.componentServiceIds) {
      componentRows.push({
        visit_id: visit.id,
        service_id: componentServiceId,
        requested_by: session.user_id,
        base_price_php: 0,
        discount_amount_php: 0,
        final_price_php: 0,
        hmo_provider_id: parsed.data.hmo_provider_id,
        hmo_approval_date: parsed.data.hmo_approval_date,
        hmo_authorization_no: parsed.data.hmo_authorization_no,
        parent_id: headerId,
        is_package_header: false,
      });
    }
  }

  // Standalone + component inserts in one batch.
  const allLeafRows = [...standaloneRows, ...componentRows];
  if (allLeafRows.length > 0) {
    const { error: leafErr } = await supabase
      .from("test_requests")
      .insert(allLeafRows);
    if (leafErr) {
      return {
        ok: false,
        error: `Visit created but tests failed: ${leafErr.message}`,
      };
    }
  }

  // PIN: generate plain → hash → store. We use the admin client because RLS on
  // visit_pins is reception/admin write only; the SSR client also satisfies
  // that, but admin is explicit about not leaking the hash through caching.
  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const admin = createAdminClient();
  const { error: pinErr } = await admin
    .from("visit_pins")
    .insert({ visit_id: visit.id, pin_hash: pinHash });
  if (pinErr) {
    return { ok: false, error: `Visit created but PIN failed: ${pinErr.message}` };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: parsed.data.patient_id,
    action: "visit.created",
    resource_type: "visit",
    resource_id: visit.id,
    metadata: {
      visit_number: visit.visit_number,
      total_php: totalPhp,
      service_count: parsed.data.service_ids.length,
      hmo_provider_id: parsed.data.hmo_provider_id,
      discounted_lines: lines.filter((l) => l.discount_amount_php > 0).length,
    },
    ip_address: ip,
    user_agent: ua,
  });

  // One audit row per package decomposition. Components codes are emitted
  // as service ids; admin can join them back to services for display.
  for (let i = 0; i < decompositions.length; i++) {
    const d = decompositions[i]!;
    const pkgService = services.find((s) => s.id === d.headerLine.service_id);
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: parsed.data.patient_id,
      action: "package.decomposed",
      resource_type: "test_request",
      resource_id: headerIdsForAudit[i] ?? null,
      metadata: {
        visit_id: visit.id,
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

  // Stash plain PIN in HttpOnly flash cookie consumed by the receipt page.
  await setVisitPinFlash({ visit_id: visit.id, pin: plainPin });

  redirect(`/staff/visits/${visit.id}/receipt`);
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
