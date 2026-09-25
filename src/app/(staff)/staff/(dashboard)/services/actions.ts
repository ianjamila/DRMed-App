"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  resolveSendOutVendorSelection,
  ServiceSchema,
  type PartnerLabOption,
  type ServiceInput,
} from "@/lib/validations/service";
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
    image_url: formData.get("image_url") ?? "",
    is_active: formData.get("is_active"),
    requires_signoff: formData.get("requires_signoff"),
    senior_pwd_eligible: formData.get("senior_pwd_eligible"),
  });
}

/** The short list a service's "Partner lab" select is allowed to resolve to. */
async function loadActivePartnerLabs(
  admin: ReturnType<typeof createAdminClient>,
): Promise<PartnerLabOption[]> {
  const { data } = await admin
    .from("vendors")
    .select("id, name")
    .eq("is_partner_lab", true)
    .eq("is_active", true)
    .order("name");
  return data ?? [];
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

  // Resolve the "Partner lab" select before writing anything, so an invalid
  // vendor never creates a half-saved service.
  const admin = createAdminClient();
  const partnerLabs = await loadActivePartnerLabs(admin);
  const sendOutVendor = resolveSendOutVendorSelection(
    parsed.data.is_send_out,
    formData.get("send_out_vendor_id") as string | null,
    partnerLabs,
  );
  if (!sendOutVendor.ok) return { ok: false, error: sendOutVendor.error };

  // The RLS-scoped client's "services: admin all" policy covers every column
  // (no column-level grants restrict send_out_vendor_id/send_out_lab), so the
  // vendor/lab pair goes into the SAME insert as the rest of the row — one
  // write, atomically committed or not at all, instead of a second write that
  // could fail and leave the service saved but untagged.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .insert({
      ...withSignoffFloor(parsed.data),
      send_out_vendor_id: sendOutVendor.data.vendorId,
      send_out_lab: sendOutVendor.data.labName,
    })
    .select("id, code")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create service.",
    };
  }

  const h = await headers();

  // Skipped when there's nothing to record (a new non-send-out service
  // already has null/null by column default).
  if (sendOutVendor.data.vendorId !== null || sendOutVendor.data.labName !== null) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "service.send_out_config_updated",
      resource_type: "service",
      resource_id: data.id,
      metadata: {
        vendor_id: sendOutVendor.data.vendorId,
        lab_name: sendOutVendor.data.labName,
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

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

  const admin = createAdminClient();
  const partnerLabs = await loadActivePartnerLabs(admin);

  const supabase = await createClient();
  // Pre-read so audit metadata can record before/after for any price column,
  // and so the resolver can tell an unrelated edit ("— Not set —" left alone,
  // or the row's own current lab re-submitted) from a deliberate change to
  // the lab — active-partner validation should only guard a NEW pick.
  const { data: prior } = await supabase
    .from("services")
    .select("code, price_php, hmo_price_php, send_out_vendor_id, send_out_lab")
    .eq("id", serviceId)
    .maybeSingle();

  const sendOutVendor = resolveSendOutVendorSelection(
    parsed.data.is_send_out,
    formData.get("send_out_vendor_id") as string | null,
    partnerLabs,
    prior ? { vendorId: prior.send_out_vendor_id, labName: prior.send_out_lab } : null,
  );
  if (!sendOutVendor.ok) return { ok: false, error: sendOutVendor.error };

  // The RLS-scoped client's "services: admin all" policy covers every column
  // (no column-level grants restrict send_out_vendor_id/send_out_lab), so the
  // vendor/lab pair goes into the SAME update as the rest of the row — one
  // write, atomically committed or not at all, instead of a second write that
  // could fail and leave the rest of the edit saved but the lab stale.
  const { error } = await supabase
    .from("services")
    .update({
      ...withSignoffFloor(parsed.data),
      send_out_vendor_id: sendOutVendor.data.vendorId,
      send_out_lab: sendOutVendor.data.labName,
    })
    .eq("id", serviceId);

  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();

  // Only audit the send-out config when it actually changes. This is also
  // what makes unticking "Send-out test" (or never having ticked it) clear a
  // stale vendor/lab pair — resolveSendOutVendorSelection always forces
  // null/null when is_send_out is false, so an untick that had a vendor set
  // differs from the prior read here and triggers the clear.
  const priorVendorId = prior?.send_out_vendor_id ?? null;
  const priorLabName = prior?.send_out_lab ?? null;
  if (
    sendOutVendor.data.vendorId !== priorVendorId ||
    sendOutVendor.data.labName !== priorLabName
  ) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "service.send_out_config_updated",
      resource_type: "service",
      resource_id: serviceId,
      metadata: {
        before: { vendor_id: priorVendorId, lab_name: priorLabName },
        after: { vendor_id: sendOutVendor.data.vendorId, lab_name: sendOutVendor.data.labName },
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  const priceChanged =
    !!prior &&
    (Number(prior.price_php) !== parsed.data.price_php ||
      (prior.hmo_price_php ?? null) !== parsed.data.hmo_price_php);

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
