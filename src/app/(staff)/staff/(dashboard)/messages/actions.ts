"use server";

// Website Messages inbox — Server Actions. Every export re-checks auth/role
// and validates its input, because a Server Action is a callable endpoint
// regardless of which page renders the button that calls it.
//
// Uses the RLS-scoped server client (not the service-role admin client) —
// 0154 grants reception/admin SELECT + UPDATE on contact_messages, so the
// database itself is the second line of defense here, same shape as
// critical-alerts/actions.ts. The sender's own fields (name, email, phone,
// subject, message, attribution, timestamps) are immutable at the DB level
// (P0053) — only status/kind/notes/linked_appointment_id can change.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  CONTACT_MESSAGE_KINDS,
  STAFF_NOTES_MAX,
  type ContactMessageKind,
} from "@/lib/contact-messages/labels";

export type MessageActionResult<T = { id: string }> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// `booked` is set only by the booking flow (linkMessageToBooking); staff can
// move a message among the other three, in either direction (including
// "Reopen" a booked/closed message back to new).
const STATUS_TARGETS = ["new", "replied", "closed"] as const;
type StatusTarget = (typeof STATUS_TARGETS)[number];

const StatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(STATUS_TARGETS),
});

const NotesSchema = z.object({
  id: z.string().uuid(),
  notes: z.string().max(STAFF_NOTES_MAX, `Notes must be ${STAFF_NOTES_MAX} characters or fewer.`),
});

const KindSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(CONTACT_MESSAGE_KINDS),
});

async function requireInboxStaff() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { session: null, error: "Only reception or admin can manage website messages." } as const;
  }
  return { session, error: null } as const;
}

function revalidateMessageSurfaces(id: string) {
  revalidatePath("/staff/messages");
  revalidatePath(`/staff/messages/${id}`);
  // The sidebar's "new messages" badge lives in the staff layout.
  revalidatePath("/staff", "layout");
}

export async function updateMessageStatusAction(
  id: string,
  status: StatusTarget,
): Promise<MessageActionResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };

  const parsed = StatusSchema.safeParse({ id, status });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid status." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("contact_messages")
    .select("id, status")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That message could not be found." };

  const { data, error } = await supabase
    .from("contact_messages")
    .update({
      status: parsed.data.status,
      handled_by: session.user_id,
      handled_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) return { ok: false, error: "That message could not be found." };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "contact_message.status_changed",
    resource_type: "contact_message",
    resource_id: parsed.data.id,
    metadata: { from: existing.status, to: parsed.data.status },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateMessageSurfaces(parsed.data.id);
  return { ok: true, data: { id: parsed.data.id } };
}

export async function updateMessageNotesAction(
  id: string,
  notes: string,
): Promise<MessageActionResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };

  const parsed = NotesSchema.safeParse({ id, notes });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid notes." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_messages")
    .update({ staff_notes: parsed.data.notes.length > 0 ? parsed.data.notes : null })
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) return { ok: false, error: "That message could not be found." };

  const { ip, ua } = await ipAndAgent();
  // Never log the note text itself — just its length, so the audit trail
  // shows notes were kept up to date without duplicating patient-adjacent
  // free text into a second table.
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "contact_message.notes_updated",
    resource_type: "contact_message",
    resource_id: parsed.data.id,
    metadata: { length: parsed.data.notes.length },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateMessageSurfaces(parsed.data.id);
  return { ok: true, data: { id: parsed.data.id } };
}

export async function updateMessageKindAction(
  id: string,
  kind: ContactMessageKind,
): Promise<MessageActionResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };

  const parsed = KindSchema.safeParse({ id, kind });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid type." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("contact_messages")
    .select("id, kind")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That message could not be found." };

  const { data, error } = await supabase
    .from("contact_messages")
    .update({ kind: parsed.data.kind })
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) return { ok: false, error: "That message could not be found." };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "contact_message.kind_changed",
    resource_type: "contact_message",
    resource_id: parsed.data.id,
    metadata: { from: existing.kind, to: parsed.data.kind },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateMessageSurfaces(parsed.data.id);
  return { ok: true, data: { id: parsed.data.id } };
}
