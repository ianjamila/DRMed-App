"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ServiceSchema } from "@/lib/validations/service";

export type ServiceResult = { ok: true } | { ok: false; error: string };

function parseForm(formData: FormData) {
  return ServiceSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    price_php: formData.get("price_php"),
    hmo_price_php: formData.get("hmo_price_php") ?? "",
    senior_discount_php: formData.get("senior_discount_php") ?? "",
    turnaround_hours: formData.get("turnaround_hours") ?? "",
    kind: formData.get("kind"),
    section: formData.get("section") ?? "",
    is_send_out: formData.get("is_send_out"),
    send_out_lab: formData.get("send_out_lab") ?? "",
    is_active: formData.get("is_active"),
    requires_signoff: formData.get("requires_signoff"),
  });
}

/** Parse send-out config fields; returns null when not a send-out service. */
function parseSendOutConfig(formData: FormData, isSendOut: boolean) {
  if (!isSendOut) return null;
  const costRaw = (formData.get("send_out_unit_cost_php") as string | null) ?? "";
  const vendorId = ((formData.get("send_out_vendor_id") as string | null) ?? "").trim();
  const costNum = costRaw === "" ? null : Number(costRaw);
  if (costRaw === "" || costNum === null || !Number.isFinite(costNum) || costNum < 0) {
    return { ok: false as const, error: "Send-out unit cost is required for send-out services." };
  }
  if (!vendorId) {
    return { ok: false as const, error: "Send-out vendor is required for send-out services." };
  }
  return { ok: true as const, cost: costNum, vendorId };
}

export async function createServiceAction(
  _prev: ServiceResult | null,
  formData: FormData,
): Promise<ServiceResult> {
  const session = await requireAdminStaff();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .insert(parsed.data)
    .select("id, code")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create service." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "service.created",
    resource_type: "service",
    resource_id: data.id,
    metadata: { code: data.code },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/services");
  redirect("/staff/services");
}

export async function updateServiceAction(
  serviceId: string,
  _prev: ServiceResult | null,
  formData: FormData,
): Promise<ServiceResult> {
  const session = await requireAdminStaff();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  // Validate send-out config when is_send_out is true.
  const sendOutResult = parseSendOutConfig(formData, parsed.data.is_send_out);
  if (sendOutResult && !sendOutResult.ok) {
    return { ok: false, error: sendOutResult.error };
  }

  const supabase = await createClient();
  // Pre-read so audit metadata can record before/after for any price column.
  const { data: prior } = await supabase
    .from("services")
    .select("price_php, hmo_price_php, senior_discount_php")
    .eq("id", serviceId)
    .maybeSingle();

  const { error } = await supabase
    .from("services")
    .update(parsed.data)
    .eq("id", serviceId);

  if (error) return { ok: false, error: error.message };

  // Persist send-out config via admin client (bypasses RLS for services).
  if (sendOutResult?.ok) {
    const admin = createAdminClient();
    const { error: soErr } = await admin
      .from("services")
      .update({
        send_out_unit_cost_php: sendOutResult.cost,
        send_out_vendor_id: sendOutResult.vendorId,
      })
      .eq("id", serviceId);
    if (soErr) return { ok: false, error: soErr.message };
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "service.send_out_config_updated",
      resource_type: "services",
      resource_id: serviceId,
      metadata: { cost: sendOutResult.cost, vendor_id: sendOutResult.vendorId },
    });
  }

  const priceChanged =
    !!prior &&
    (Number(prior.price_php) !== parsed.data.price_php ||
      (prior.hmo_price_php ?? null) !== parsed.data.hmo_price_php ||
      (prior.senior_discount_php ?? null) !== parsed.data.senior_discount_php);

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: priceChanged ? "service.price_changed" : "service.updated",
    resource_type: "service",
    resource_id: serviceId,
    metadata: priceChanged
      ? {
          code: parsed.data.code,
          before: prior,
          after: {
            price_php: parsed.data.price_php,
            hmo_price_php: parsed.data.hmo_price_php,
            senior_discount_php: parsed.data.senior_discount_php,
          },
        }
      : { code: parsed.data.code },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/services");
  revalidatePath(`/staff/services/${serviceId}/edit`);
  redirect("/staff/services");
}
