"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  DiscountTypeBuiltinUpdateSchema,
  DiscountTypeCreateSchema,
  DiscountTypeUpdateSchema,
  slugifyDiscountCode,
} from "@/lib/validations/discount-type";

export type DiscountTypeResult =
  | { ok: true }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    label: formData.get("label"),
    kind: formData.get("kind"),
    percent: formData.get("percent"),
    amount_php: formData.get("amount_php"),
    active: formData.get("active"),
    sort_order: formData.get("sort_order"),
  };
}

export async function createDiscountTypeAction(
  _prev: DiscountTypeResult | null,
  formData: FormData,
): Promise<DiscountTypeResult> {
  const session = await requireAdminStaff();
  const parsed = DiscountTypeCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  // Percent rows carry percent only, fixed rows amount only (DB CHECK).
  const values = {
    ...parsed.data,
    percent: parsed.data.kind === "percent" ? parsed.data.percent : null,
    amount_php: parsed.data.kind === "fixed" ? parsed.data.amount_php : null,
    sort_order: parsed.data.sort_order ?? 100,
    code: slugifyDiscountCode(parsed.data.label),
  };

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("discount_types")
    .insert(values)
    .select("id, code, label")
    .single();
  if (error || !created) {
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "A discount with a very similar name already exists — rename it or reactivate the existing one.",
      };
    }
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create discount.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "discount_type.created",
    resource_type: "discount_type",
    resource_id: created.id,
    metadata: { code: created.code, ...parsed.data },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/discounts");
  redirect("/staff/admin/discounts");
}

export async function updateDiscountTypeAction(
  discountTypeId: string,
  _prev: DiscountTypeResult | null,
  formData: FormData,
): Promise<DiscountTypeResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("discount_types")
    .select("id, code, kind, is_statutory")
    .eq("id", discountTypeId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That discount no longer exists." };

  // Built-in rows (statutory Senior/PWD, counter-typed custom) only accept
  // label / active / sort order; the statutory guard trigger enforces the
  // Senior/PWD rate at the DB level regardless of what reaches it.
  const isBuiltin = existing.is_statutory || existing.kind === "custom";
  let values: {
    label: string;
    active?: boolean;
    sort_order?: number;
    kind?: "percent" | "fixed";
    percent?: number | null;
    amount_php?: number | null;
  };
  if (isBuiltin) {
    const parsed = DiscountTypeBuiltinUpdateSchema.safeParse({
      label: formData.get("label"),
      active: formData.get("active"),
      sort_order: formData.get("sort_order"),
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Please check the form.",
      };
    }
    values = {
      label: parsed.data.label,
      // Statutory discounts can never be switched off.
      active: existing.is_statutory ? true : parsed.data.active,
      sort_order: parsed.data.sort_order ?? undefined,
    };
  } else {
    const parsed = DiscountTypeUpdateSchema.safeParse(readForm(formData));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Please check the form.",
      };
    }
    values = {
      ...parsed.data,
      percent: parsed.data.kind === "percent" ? parsed.data.percent : null,
      amount_php: parsed.data.kind === "fixed" ? parsed.data.amount_php : null,
      sort_order: parsed.data.sort_order ?? undefined,
    };
  }

  const { error } = await admin
    .from("discount_types")
    .update(values)
    .eq("id", discountTypeId);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "discount_type.updated",
    resource_type: "discount_type",
    resource_id: discountTypeId,
    metadata: { code: existing.code, ...values },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/discounts");
  revalidatePath(`/staff/admin/discounts/${discountTypeId}/edit`);
  redirect("/staff/admin/discounts");
}
