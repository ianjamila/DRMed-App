"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { vendorCreateSchema, vendorUpdateSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { reportError } from "@/lib/observability/report-error";
import { revalidatePath } from "next/cache";
import type { z } from "zod";

type VendorCreateInput = z.infer<typeof vendorCreateSchema>;
type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string | null };

function firstFieldFrom(path: ReadonlyArray<PropertyKey>): string | null {
  const p = path[0];
  return typeof p === "string" ? p : null;
}

// ---------------------------------------------------------------------------
// list + get
// ---------------------------------------------------------------------------

export async function listVendorsAction(filter?: {
  active?: boolean;
  search?: string;
}): Promise<ActionResult<Array<{
  id: string; name: string; tin: string | null; is_active: boolean;
  outstanding_php: number; ytd_spend_php: number; last_bill_date: string | null;
}>>> {
  await requireAdminStaff();
  const admin = createAdminClient();

  let q = admin.from("vendors").select(`
    id, name, tin, is_active,
    bills:bills!vendor_id (
      outstanding_amount, gross_amount, bill_date, status
    )
  `).order("name");

  if (filter?.active !== undefined) q = q.eq("is_active", filter.active);
  if (filter?.search) q = q.ilike("name", `%${filter.search}%`);

  const { data, error } = await q;
  if (error) {
    await reportError({ scope: "listVendorsAction", error });
    return { ok: false, error: "Failed to load vendors" };
  }

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);

  type BillAgg = { outstanding_amount: number | null; gross_amount: number | null; bill_date: string; status: string };
  type VendorRow = { id: string; name: string; tin: string | null; is_active: boolean; bills: BillAgg[] | null };

  const rows = ((data ?? []) as VendorRow[]).map((v) => {
    const liveBills = (v.bills ?? []).filter((b) => b.status !== "voided");
    return {
      id: v.id,
      name: v.name,
      tin: v.tin,
      is_active: v.is_active,
      outstanding_php: liveBills.reduce((s, b) => s + Number(b.outstanding_amount ?? 0), 0),
      ytd_spend_php: liveBills.filter((b) => b.bill_date >= yearStart)
        .reduce((s, b) => s + Number(b.gross_amount ?? 0), 0),
      last_bill_date: liveBills.map((b) => b.bill_date).sort().pop() ?? null,
    };
  });

  return { ok: true, data: rows };
}

export async function getVendorAction(id: string): Promise<ActionResult<Awaited<ReturnType<typeof loadVendor>>>> {
  await requireAdminStaff();
  const result = await loadVendor(id);
  if (!result) return { ok: false, error: "Vendor not found" };
  return { ok: true, data: result };
}

async function loadVendor(id: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("vendors").select("*").eq("id", id).maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// create + update
// ---------------------------------------------------------------------------

export async function createVendorAction(input: VendorCreateInput): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = vendorCreateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "Invalid input", field: first ? firstFieldFrom(first.path) : null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.from("vendors").insert({
    ...parsed.data,
    created_by: profile.user_id,
    updated_by: profile.user_id,
  }).select("id").single();

  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "vendor.created",
    resource_type: "vendor",
    resource_id: data.id,
    metadata: parsed.data,
  });

  revalidatePath("/staff/admin/accounting/ap/vendors");
  return { ok: true, data: { id: data.id } };
}

export async function updateVendorAction(
  id: string,
  input: VendorUpdateInput
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const parsed = vendorUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "Invalid input", field: first ? firstFieldFrom(first.path) : null };
  }

  const admin = createAdminClient();
  const { data: before } = await admin.from("vendors").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Vendor not found" };

  const { error } = await admin.from("vendors").update({
    ...parsed.data,
    updated_by: profile.user_id,
  }).eq("id", id);

  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "vendor.updated",
    resource_type: "vendor",
    resource_id: id,
    metadata: { before, after: parsed.data },
  });

  revalidatePath("/staff/admin/accounting/ap/vendors");
  revalidatePath(`/staff/admin/accounting/ap/vendors/${id}`);
  return { ok: true, data: { id } };
}

// ---------------------------------------------------------------------------
// deactivate + reactivate
// ---------------------------------------------------------------------------

export async function deactivateVendorAction(id: string): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: updated, error } = await admin.from("vendors")
    .update({ is_active: false, updated_by: profile.user_id })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) return { ok: false, error: "Vendor not found" };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "vendor.deactivated",
    resource_type: "vendor",
    resource_id: id,
    metadata: { is_active: false },
  });

  revalidatePath("/staff/admin/accounting/ap/vendors");
  revalidatePath(`/staff/admin/accounting/ap/vendors/${id}`);
  return { ok: true, data: null };
}

export async function reactivateVendorAction(id: string): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: updated, error } = await admin.from("vendors")
    .update({ is_active: true, updated_by: profile.user_id })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) return { ok: false, error: "Vendor not found" };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "vendor.reactivated",
    resource_type: "vendor",
    resource_id: id,
    metadata: { is_active: true },
  });

  revalidatePath("/staff/admin/accounting/ap/vendors");
  revalidatePath(`/staff/admin/accounting/ap/vendors/${id}`);
  return { ok: true, data: null };
}
