import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseAttributionCookie, type Attribution } from "@/lib/analytics/attribution";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  isContactMessageKind,
  isContactMessageStatus,
  type ContactMessageKind,
  type ContactMessageStatus,
} from "@/lib/contact-messages/labels";

// The seam between the Website Messages inbox and the appointment booking
// core: the inbox's "Book appointment" button opens the staff slide-over
// pre-filled from `loadMessageForBooking`, and `createStaffAppointmentAction`
// calls `linkMessageToBooking` once the appointment exists.
//
// Both take the caller's client. Pass the RLS-scoped server client — reception
// and admin can read and update contact_messages under 0154's policies, so
// nobody else can load or link a message through here.

export interface MessageForBooking {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  subject: string | null;
  kind: ContactMessageKind;
  status: ContactMessageStatus;
  attribution: Attribution | null;
  linkedAppointmentId: string | null;
}

// The stored jsonb is the attribution cookie payload verbatim; round-trip it
// through the cookie parser so a malformed value degrades to null.
function toAttribution(value: unknown): Attribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseAttributionCookie(JSON.stringify(value));
}

export async function loadMessageForBooking(
  client: SupabaseClient<Database>,
  id: string,
): Promise<MessageForBooking | null> {
  const { data, error } = await client
    .from("contact_messages")
    .select("id, name, phone, email, subject, kind, status, attribution, linked_appointment_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    name: data.name,
    phone: data.phone,
    email: data.email,
    subject: data.subject,
    kind: isContactMessageKind(data.kind) ? data.kind : "general",
    status: isContactMessageStatus(data.status) ? data.status : "new",
    attribution: toAttribution(data.attribution),
    linkedAppointmentId: data.linked_appointment_id,
  };
}

// Marks the message Booked and points it at the booking's lead appointment
// row. Never rolls back the appointment on failure — the caller logs the
// error and the message can still be closed by hand.
//
// The update is conditional on the message not being Booked already: the
// caller's "already booked?" check runs before the appointment is created, so
// two people booking the same message at once would both pass it, and an
// unconditional update would silently re-point the first booking's link at
// the second. Losing that race leaves the first link intact and reports it.
export async function linkMessageToBooking(
  client: SupabaseClient<Database>,
  input: { messageId: string; appointmentId: string; staffUserId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await client
    .from("contact_messages")
    .update({
      status: "booked",
      linked_appointment_id: input.appointmentId,
      handled_by: input.staffUserId,
      handled_at: new Date().toISOString(),
    })
    .eq("id", input.messageId)
    .neq("status", "booked")
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "That website message could not be found, or someone else booked it at the same time.",
    };
  }
  return { ok: true };
}
