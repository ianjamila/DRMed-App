"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const ItemSchema = z.object({
  code: z.string().max(40).optional().nullable(),
  name: z.string().trim().min(1).max(200),
  section: z.string().max(40).optional().nullable(),
  unit: z.string().trim().min(1).max(20),
  reorder_threshold: z.number().min(0).max(99_999_999),
  expiry_tracking: z.boolean(),
  vendor_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
});

const MovementSchema = z.object({
  item_id: z.string().uuid(),
  movement_type: z.enum(["receive", "issue", "adjust", "expire", "count"]),
  quantity: z.number().refine((n) => n !== 0, "Quantity can't be zero."),
  unit_cost_php: z.number().min(0).max(99_999_999).optional().nullable(),
  expiry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  lot_number: z.string().max(80).optional().nullable(),
  reference: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: string };

async function writeItem(
  input: z.infer<typeof ItemSchema>,
  itemId: string | null,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = ItemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const data = parsed.data;

  const admin = createAdminClient();
  if (itemId) {
    const { error } = await admin
      .from("inventory_items")
      .update({
        code: data.code || null,
        name: data.name,
        section: data.section || null,
        unit: data.unit,
        reorder_threshold: data.reorder_threshold,
        expiry_tracking: data.expiry_tracking,
        vendor_id: data.vendor_id || null,
        notes: data.notes || null,
        is_active: data.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);
    if (error) return { ok: false, error: error.message };
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "inventory_item.updated",
      resource_type: "inventory_items",
      resource_id: itemId,
      metadata: { name: data.name, is_active: data.is_active },
    });
    revalidatePath("/staff/admin/inventory");
    revalidatePath(`/staff/admin/inventory/${itemId}`);
    return { ok: true, data: { id: itemId } };
  }

  const { data: row, error } = await admin
    .from("inventory_items")
    .insert({
      code: data.code || null,
      name: data.name,
      section: data.section || null,
      unit: data.unit,
      reorder_threshold: data.reorder_threshold,
      expiry_tracking: data.expiry_tracking,
      vendor_id: data.vendor_id || null,
      notes: data.notes || null,
      is_active: data.is_active,
      created_by: session.user_id,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Insert failed." };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "inventory_item.created",
    resource_type: "inventory_items",
    resource_id: row.id,
    metadata: { name: data.name },
  });

  revalidatePath("/staff/admin/inventory");
  return { ok: true, data: { id: row.id } };
}

export async function createInventoryItem(input: z.infer<typeof ItemSchema>) {
  return writeItem(input, null);
}

export async function updateInventoryItem(
  id: string,
  input: z.infer<typeof ItemSchema>,
) {
  return writeItem(input, id);
}

export async function recordMovement(
  input: z.infer<typeof MovementSchema>,
): Promise<ActionResult> {
  // Lab roles can post movements, not just admin.
  const session = await requireActiveStaff();
  if (
    session.role !== "admin" &&
    session.role !== "medtech" &&
    session.role !== "xray_technician"
  ) {
    return { ok: false, error: "Only admin and lab staff can record movements." };
  }

  const parsed = MovementSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const data = parsed.data;

  // Sign convention: receive / adjust-up are positive; issue / expire are
  // negative. Form lets user enter a positive number always; we flip the
  // sign here based on movement_type.
  let signed = Math.abs(data.quantity);
  if (
    data.movement_type === "issue" ||
    data.movement_type === "expire"
  ) {
    signed = -signed;
  } else if (data.movement_type === "adjust") {
    // For 'adjust' the form already provides the signed delta.
    signed = data.quantity;
  } else if (data.movement_type === "count") {
    signed = data.quantity;
  }

  const admin = createAdminClient();
  const { error } = await admin.from("inventory_movements").insert({
    item_id: data.item_id,
    movement_type: data.movement_type,
    quantity: signed,
    unit_cost_php: data.unit_cost_php ?? null,
    expiry_date: data.expiry_date ?? null,
    lot_number: data.lot_number ?? null,
    reference: data.reference ?? null,
    notes: data.notes ?? null,
    created_by: session.user_id,
  });
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: `inventory.${data.movement_type}`,
    resource_type: "inventory_movements",
    resource_id: data.item_id,
    metadata: {
      movement_type: data.movement_type,
      quantity: signed,
      unit_cost_php: data.unit_cost_php ?? null,
    },
  });

  revalidatePath("/staff/admin/inventory");
  revalidatePath(`/staff/admin/inventory/${data.item_id}`);
  return { ok: true };
}

export async function recordMovementAndRedirect(
  input: z.infer<typeof MovementSchema>,
) {
  const r = await recordMovement(input);
  if (r.ok) {
    redirect(`/staff/admin/inventory/${input.item_id}`);
  }
  return r;
}
