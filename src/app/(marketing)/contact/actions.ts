"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { ContactSchema } from "@/lib/validations/contact";

export type ContactResult = { ok: true } | { ok: false; error: string };

export async function submitContactMessage(
  _prev: ContactResult | null,
  formData: FormData,
): Promise<ContactResult> {
  // Honeypot — silent drop if filled.
  if ((formData.get("website") ?? "") !== "") {
    return { ok: true };
  }

  const parsed = ContactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
    subject: formData.get("subject") ?? "",
    message: formData.get("message"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  const admin = createAdminClient();
  const { error } = await admin.from("contact_messages").insert({
    name: parsed.data.name,
    email: parsed.data.email || null,
    phone: parsed.data.phone || null,
    subject: parsed.data.subject || null,
    message: parsed.data.message,
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  if (error) {
    console.error("contact_messages insert failed", error);
    return {
      ok: false,
      error: "Sorry — we couldn't send your message. Please try again or call us.",
    };
  }

  return { ok: true };
}
