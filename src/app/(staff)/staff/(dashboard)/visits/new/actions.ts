"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { generatePin, hashPin } from "@/lib/auth/pin";
import { setVisitPinFlash } from "@/lib/auth/visit-pin-flash";

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
    .select("id, price_php, hmo_price_php, senior_discount_php")
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
    return {
      service_id,
      base_price_php: base,
      discount_kind,
      discount_amount_php,
      final_price_php,
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

  // Test requests with snapshotted prices + per-line discount info. The
  // visit-level HMO id/date/auth are denormalised onto each line too so the
  // accounting export rows are self-contained.
  const requestRows = lines.map((l) => ({
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
  }));
  const { error: trErr } = await supabase
    .from("test_requests")
    .insert(requestRows);
  if (trErr) {
    return { ok: false, error: `Visit created but tests failed: ${trErr.message}` };
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
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Stash plain PIN in HttpOnly flash cookie consumed by the receipt page.
  await setVisitPinFlash({ visit_id: visit.id, pin: plainPin });

  redirect(`/staff/visits/${visit.id}/receipt`);
}
