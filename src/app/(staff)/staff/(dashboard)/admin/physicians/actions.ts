"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  PhysicianCreateSchema,
  PhysicianUpdateSchema,
} from "@/lib/validations/physician";

export type PhysicianResult =
  | { ok: true }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    slug: formData.get("slug"),
    full_name: formData.get("full_name"),
    specialty: formData.get("specialty"),
    group_label: formData.get("group_label"),
    bio: formData.get("bio"),
    is_active: formData.get("is_active"),
    display_order: formData.get("display_order"),
  };
}

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function createPhysicianAction(
  _prev: PhysicianResult | null,
  formData: FormData,
): Promise<PhysicianResult> {
  const session = await requireAdminStaff();
  const parsed = PhysicianCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("physicians")
    .insert(parsed.data)
    .select("id, slug")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error?.message ?? "Could not create physician.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.created",
    resource_type: "physician",
    resource_id: created.id,
    metadata: { slug: created.slug },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/physicians");
  redirect("/staff/admin/physicians");
}

export async function updatePhysicianAction(
  physicianId: string,
  _prev: PhysicianResult | null,
  formData: FormData,
): Promise<PhysicianResult> {
  const session = await requireAdminStaff();
  const parsed = PhysicianUpdateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("physicians")
    .update(parsed.data)
    .eq("id", physicianId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.updated",
    resource_type: "physician",
    resource_id: physicianId,
    metadata: { slug: parsed.data.slug },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/physicians");
  revalidatePath(`/staff/admin/physicians/${physicianId}/edit`);
  redirect("/staff/admin/physicians");
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function extensionFor(mime: string): "jpg" | "png" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export async function uploadPhotoAction(
  physicianId: string,
  _prev: PhysicianResult | null,
  formData: FormData,
): Promise<PhysicianResult> {
  const session = await requireAdminStaff();

  const photo = formData.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return { ok: false, error: "Pick a photo to upload." };
  }
  if (!ACCEPTED_MIME.has(photo.type)) {
    return { ok: false, error: "Photo must be JPG, PNG, or WebP." };
  }
  if (photo.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: "Photo must be under 5 MB." };
  }

  const admin = createAdminClient();

  const { data: physician } = await admin
    .from("physicians")
    .select("slug")
    .eq("id", physicianId)
    .maybeSingle();
  if (!physician) {
    return { ok: false, error: "Physician not found." };
  }

  const ext = extensionFor(photo.type);
  // Cache-busting query string isn't enough since some clients ignore it
  // for <img>; vary the path with a random suffix so a re-upload is a new URL.
  const suffix = Math.random().toString(36).slice(2, 8);
  const storagePath = `${physician.slug}-${suffix}.${ext}`;

  const { error: upErr } = await admin.storage
    .from("physician-photos")
    .upload(storagePath, photo, {
      contentType: photo.type,
      upsert: true,
    });
  if (upErr) {
    return { ok: false, error: upErr.message };
  }

  const { error: updateErr } = await admin
    .from("physicians")
    .update({ photo_path: storagePath })
    .eq("id", physicianId);
  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.photo_uploaded",
    resource_type: "physician",
    resource_id: physicianId,
    metadata: {
      slug: physician.slug,
      storage_path: storagePath,
      mime: photo.type,
      bytes: photo.size,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/physicians");
  revalidatePath(`/staff/admin/physicians/${physicianId}/edit`);
  return { ok: true };
}
