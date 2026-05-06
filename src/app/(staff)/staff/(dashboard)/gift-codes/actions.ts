"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff, type StaffSession } from "@/lib/auth/require-staff";
import { SellGiftCodeSchema } from "@/lib/validations/gift-code";

export type SellResult = { ok: true } | { ok: false; error: string };

function requireReception(role: StaffSession["role"]): boolean {
  return role === "reception" || role === "admin";
}

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function sellGiftCodeAction(
  _prev: SellResult | null,
  formData: FormData,
): Promise<SellResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = SellGiftCodeSchema.safeParse({
    code: formData.get("code"),
    buyer_name: formData.get("buyer_name"),
    buyer_contact: formData.get("buyer_contact"),
    purchase_method: formData.get("purchase_method"),
    purchase_reference_number: formData.get("purchase_reference_number"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  const { data: code } = await admin
    .from("gift_codes")
    .select("id, status, face_value_php")
    .eq("code", parsed.data.code)
    .maybeSingle();
  if (!code) {
    return { ok: false, error: "No gift code found with that number." };
  }
  if (code.status !== "generated") {
    return {
      ok: false,
      error:
        code.status === "purchased"
          ? "This code has already been sold."
          : code.status === "redeemed"
            ? "This code has already been redeemed."
            : "This code has been cancelled and cannot be sold.",
    };
  }

  const { error } = await admin
    .from("gift_codes")
    .update({
      status: "purchased",
      purchased_at: new Date().toISOString(),
      purchased_by_name: parsed.data.buyer_name,
      purchased_by_contact: parsed.data.buyer_contact,
      purchase_method: parsed.data.purchase_method,
      purchase_reference_number: parsed.data.purchase_reference_number,
      sold_by: session.user_id,
      // Concat user notes onto whatever admin set at generation, if any.
      // The admin notes are preserved on the row already; appending here
      // would clobber them, so we only write notes when reception added some.
      ...(parsed.data.notes
        ? { notes: parsed.data.notes }
        : {}),
    })
    .eq("id", code.id)
    .eq("status", "generated"); // optimistic concurrency: protects against double-sale
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "gift_code.sold",
    resource_type: "gift_code",
    resource_id: code.id,
    metadata: {
      code: parsed.data.code,
      face_value_php: code.face_value_php,
      buyer_name: parsed.data.buyer_name,
      method: parsed.data.purchase_method,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/gift-codes/sell");
  revalidatePath("/staff/admin/gift-codes");
  redirect(
    `/staff/gift-codes/sell?sold=${encodeURIComponent(parsed.data.code)}`,
  );
}
