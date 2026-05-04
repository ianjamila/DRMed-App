"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";

const priceField = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    const s = typeof v === "string" ? v.trim() : String(v);
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  })
  .refine((v) => v === null || v >= 0, {
    message: "Must be 0 or greater.",
  });

const PriceUpdateSchema = z.object({
  service_id: z.string().uuid(),
  price_php: priceField.refine((v) => v !== null, {
    message: "DRMed price is required.",
  }),
  hmo_price_php: priceField,
  senior_discount_php: priceField,
});

export type PriceUpdateResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateServicePricesAction(
  raw: z.input<typeof PriceUpdateSchema>,
): Promise<PriceUpdateResult> {
  const session = await requireAdminStaff();
  const parsed = PriceUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { service_id, price_php, hmo_price_php, senior_discount_php } =
    parsed.data;

  const supabase = await createClient();
  const { data: prior } = await supabase
    .from("services")
    .select("code, price_php, hmo_price_php, senior_discount_php")
    .eq("id", service_id)
    .maybeSingle();

  if (!prior) return { ok: false, error: "Service not found." };

  const changed =
    Number(prior.price_php) !== price_php ||
    (prior.hmo_price_php ?? null) !== hmo_price_php ||
    (prior.senior_discount_php ?? null) !== senior_discount_php;

  if (!changed) return { ok: true };

  const { error } = await supabase
    .from("services")
    .update({
      price_php: price_php as number,
      hmo_price_php,
      senior_discount_php,
    })
    .eq("id", service_id);

  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "service.price_changed",
    resource_type: "service",
    resource_id: service_id,
    metadata: {
      code: prior.code,
      before: prior,
      after: { price_php, hmo_price_php, senior_discount_php },
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/prices");
  return { ok: true };
}

export interface PriceHistoryEntry {
  id: number;
  effective_from: string;
  price_php: number | null;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  changed_by_name: string | null;
  change_reason: string | null;
}

export async function fetchServiceHistoryAction(
  serviceId: string,
): Promise<PriceHistoryEntry[]> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const { data: history } = await admin
    .from("service_price_history")
    .select(
      "id, price_php, hmo_price_php, senior_discount_php, effective_from, changed_by, change_reason",
    )
    .eq("service_id", serviceId)
    .order("effective_from", { ascending: false })
    .limit(50);

  const ids = Array.from(
    new Set(
      (history ?? [])
        .map((h) => h.changed_by)
        .filter((v): v is string => !!v),
    ),
  );
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", ids);
    for (const s of staff ?? []) nameById.set(s.id, s.full_name);
  }

  return (history ?? []).map((h) => ({
    id: h.id,
    effective_from: h.effective_from,
    price_php: h.price_php != null ? Number(h.price_php) : null,
    hmo_price_php: h.hmo_price_php != null ? Number(h.hmo_price_php) : null,
    senior_discount_php:
      h.senior_discount_php != null ? Number(h.senior_discount_php) : null,
    changed_by_name: h.changed_by ? (nameById.get(h.changed_by) ?? null) : null,
    change_reason: h.change_reason,
  }));
}
