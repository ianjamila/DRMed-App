"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ServiceSchema, type ServiceInput } from "@/lib/validations/service";
import { SITE } from "@/lib/marketing/site";
import { submitToIndexNow } from "@/lib/seo/indexnow";
import { servicePageUrls } from "@/lib/seo/indexnow-core";

export type ServiceResult = { ok: true } | { ok: false; error: string };

function parseForm(formData: FormData) {
  return ServiceSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    price_php: formData.get("price_php"),
    hmo_price_php: formData.get("hmo_price_php") ?? "",
    turnaround_hours: formData.get("turnaround_hours") ?? "",
    kind: formData.get("kind"),
    section: formData.get("section") ?? "",
    is_send_out: formData.get("is_send_out"),
    send_out_lab: formData.get("send_out_lab") ?? "",
    image_url: formData.get("image_url") ?? "",
    is_active: formData.get("is_active"),
    requires_signoff: formData.get("requires_signoff"),
    senior_pwd_eligible: formData.get("senior_pwd_eligible"),
  });
}

/**
 * M13 — requires_signoff has no working UI yet (the sign-off queue isn't
 * built; the checkbox is permanently disabled in service-form.tsx) so the
 * feature must stay dormant on every service. This is the server-side floor:
 * without it a crafted POST straight to the action (bypassing the disabled
 * checkbox) could flip requires_signoff on. Always force it false here —
 * remove this once the sign-off queue ships and the checkbox is re-enabled.
 */
function withSignoffFloor(data: ServiceInput): ServiceInput {
  return { ...data, requires_signoff: false };
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
    .insert(withSignoffFloor(parsed.data))
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

  await submitToIndexNow(servicePageUrls(SITE.url, data.code), {
    trigger: "service.created",
    actor: {
      id: session.user_id,
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      ua: h.get("user-agent"),
    },
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

  const supabase = await createClient();
  // Pre-read so audit metadata can record before/after for any price column.
  const { data: prior } = await supabase
    .from("services")
    .select("code, price_php, hmo_price_php")
    .eq("id", serviceId)
    .maybeSingle();

  const { error } = await supabase
    .from("services")
    .update(withSignoffFloor(parsed.data))
    .eq("id", serviceId);

  if (error) return { ok: false, error: error.message };

  const priceChanged =
    !!prior &&
    (Number(prior.price_php) !== parsed.data.price_php ||
      (prior.hmo_price_php ?? null) !== parsed.data.hmo_price_php);

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
          },
        }
      : { code: parsed.data.code },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  const codes = new Set<string>([parsed.data.code]);
  if (prior?.code && prior.code !== parsed.data.code) codes.add(prior.code);
  await submitToIndexNow(
    [...codes].flatMap((c) => servicePageUrls(SITE.url, c)),
    {
      trigger: "service.updated",
      actor: {
        id: session.user_id,
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        ua: h.get("user-agent"),
      },
    },
  );

  revalidatePath("/staff/services");
  revalidatePath(`/staff/services/${serviceId}/edit`);
  redirect("/staff/services");
}
