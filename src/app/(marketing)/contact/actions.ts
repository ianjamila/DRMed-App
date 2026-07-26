"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { ContactSchema } from "@/lib/validations/contact";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { sendMetaCapiEvent } from "@/lib/analytics/meta-capi";
import { SITE } from "@/lib/marketing/site";

export type ContactResult = { ok: true } | { ok: false; error: string };

// Kept in sync with contact-form.tsx's CORPORATE_SUBJECT.
const CORPORATE_SUBJECT = "Corporate / HMO";

export async function submitContactMessage(
  _prev: ContactResult | null,
  formData: FormData,
): Promise<ContactResult> {
  // Honeypot — silent drop if filled.
  if ((formData.get("website") ?? "") !== "") {
    return { ok: true };
  }

  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  if (ipAddress) {
    const limit = await checkRateLimit({
      bucket: "contact_form",
      identifier: ipAddress,
      ...RATE_LIMITS.contact_form,
    });
    if (!limit.allowed) {
      return {
        ok: false,
        error: `Too many messages from your network. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call us directly.`,
      };
    }
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

  // Server-side mirror of the browser Pixel event fired from contact-form.tsx,
  // de-duped via the shared event_id. Corporate/HMO inquiries fire as a
  // distinct "Lead" event (higher-intent B2B) vs the general "Contact" event.
  const eventId = formData.get("event_id");
  if (typeof eventId === "string" && eventId) {
    const isCorporate = parsed.data.subject === CORPORATE_SUBJECT;
    await sendMetaCapiEvent({
      eventName: isCorporate ? "Lead" : "Contact",
      eventId,
      eventSourceUrl: `${SITE.url.replace(/\/$/, "")}/contact`,
      customData: {
        content_name: isCorporate ? "corporate_quote_request" : "contact_form",
      },
      userData: { clientIpAddress: ipAddress, clientUserAgent: userAgent },
    });
  }

  return { ok: true };
}
