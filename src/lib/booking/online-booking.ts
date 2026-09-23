import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import type { OnlineBookingStatus } from "./online-booking-copy";

// Reads the booking_settings singleton (0153). Service-role, like
// isConsentGateRequired — anon has no policy on the table.
//
// Wrapped in React cache(): the marketing layout, the page and its JSON-LD all
// ask during one render, and they share a single query.
//
// Static marketing pages bake this value in at build/revalidation time, so the
// admin action calls revalidatePath("/", "layout") on every change.
//
// Fails OPEN: if the read errors, booking behaves as it did before the switch
// existed. A booking that slips through during a DB blip is a phone call for
// reception; a false "paused" notice would turn away every patient.
export const getOnlineBookingStatus = cache(async function getOnlineBookingStatus(): Promise<OnlineBookingStatus> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("booking_settings")
    .select("online_booking_paused, paused_message")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    void reportError({ scope: "booking/pause-settings-read", error });
    return { paused: false, message: null };
  }
  return {
    paused: !!data?.online_booking_paused,
    message: data?.paused_message ?? null,
  };
});
