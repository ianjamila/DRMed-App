"use server";

import { revalidatePath } from "next/cache";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { normalizePausedMessage } from "@/lib/booking/online-booking-copy";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Pause or resume patient-facing online booking (public /schedule and the
// portal's /portal/book) and set the optional note shown on the paused notice.
// Admin-only. Staff booking through "+ New appointment" is never affected.
//
// Every export of a "use server" file is a callable endpoint, so the input is
// re-validated here rather than trusted from the form.
export async function updateOnlineBookingSettingsAction(input: {
  paused: boolean;
  message: string | null;
}): Promise<ActionResult> {
  const session = await requireAdminStaff();

  if (typeof input?.paused !== "boolean") {
    return { ok: false, error: "Could not read the setting. Reload and try again." };
  }
  const normalized = normalizePausedMessage(input.message);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("booking_settings")
    .select("online_booking_paused, paused_message")
    .eq("id", true)
    .maybeSingle();
  if (readError) return { ok: false, error: "Could not load the current setting. Try again." };

  const wasPaused = !!before?.online_booking_paused;
  const previousMessage = before?.paused_message ?? null;
  if (wasPaused === input.paused && previousMessage === normalized.message) {
    return { ok: true }; // nothing changed — no write, no audit row
  }

  // Upsert rather than update: 0153 seeds the singleton, but an update that
  // matches zero rows would report success while changing nothing.
  const { error } = await admin.from("booking_settings").upsert(
    {
      id: true,
      online_booking_paused: input.paused,
      paused_message: normalized.message,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: "Could not save the setting. Try again." };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action:
      wasPaused === input.paused
        ? "online_booking.message_updated"
        : input.paused
          ? "online_booking.paused"
          : "online_booking.resumed",
    resource_type: "booking_settings",
    // Global singleton (no per-row UUID) — same as consent_settings; the
    // change itself is captured in metadata.
    resource_id: null,
    metadata: {
      paused: input.paused,
      was_paused: wasPaused,
      message: normalized.message,
      previous_message: previousMessage,
    },
    ip_address: ip,
    user_agent: ua,
  });

  // Every page under the root layout: the marketing site is mostly statically
  // prerendered (or ISR), so the site-wide strip, the relabelled "Book" CTAs
  // and the JSON-LD ReserveAction were baked in with the old value. This also
  // covers /schedule, /portal/book and the staff Appointments banner.
  revalidatePath("/", "layout");
  return { ok: true };
}
