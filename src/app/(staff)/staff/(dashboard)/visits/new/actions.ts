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

const Schema = z.object({
  patient_id: z.string().uuid("Pick a valid patient."),
  service_ids: z
    .array(z.string().uuid())
    .min(1, "Select at least one service."),
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
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();

  // Total = sum of selected service prices.
  const { data: services, error: svcErr } = await supabase
    .from("services")
    .select("id, price_php")
    .in("id", parsed.data.service_ids);

  if (svcErr || !services || services.length !== parsed.data.service_ids.length) {
    return {
      ok: false,
      error: "One or more services could not be found.",
    };
  }
  const totalPhp = services.reduce((sum, s) => sum + Number(s.price_php), 0);

  // Create the visit.
  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .insert({
      patient_id: parsed.data.patient_id,
      total_php: totalPhp,
      notes: parsed.data.notes ?? null,
      created_by: session.user_id,
    })
    .select("id, visit_number")
    .single();

  if (visitErr || !visit) {
    return {
      ok: false,
      error: visitErr?.message ?? "Could not create visit.",
    };
  }

  // Test requests, one per service.
  const requestRows = parsed.data.service_ids.map((service_id) => ({
    visit_id: visit.id,
    service_id,
    requested_by: session.user_id,
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
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Stash plain PIN in HttpOnly flash cookie consumed by the receipt page.
  await setVisitPinFlash({ visit_id: visit.id, pin: plainPin });

  redirect(`/staff/visits/${visit.id}/receipt`);
}
