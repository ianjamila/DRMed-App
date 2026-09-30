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
import { reportError } from "@/lib/observability/report-error";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { sendEmail } from "@/lib/notifications/email";
import { sendSms, normalizePhPhone } from "@/lib/notifications/sms";
import {
  CONTACT_MESSAGE_KINDS,
  CONTACT_MESSAGE_STATUSES,
  STAFF_NOTES_MAX,
  type ContactMessageKind,
  type ContactMessageStatus,
  type ReplyChannel,
  type ReplyOutcome,
} from "@/lib/contact-messages/labels";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { STAFF_STATUS_TARGETS, canTransition, type StaffStatusTarget } from "@/lib/contact-messages/status-transitions";
import { MAX_BULK_ROWS } from "@/lib/ui/bulk-selection";
import {
  MESSAGE_CHANGED_REASON,
  MESSAGE_GONE_REASON,
  MESSAGE_WRITE_FAILED_REASON,
  groupMessagesForWrite,
  notAllowedReason,
  type BulkMessageResult,
  type MessageWriteRow,
} from "@/lib/contact-messages/bulk-status";
import { ReplyInputSchema, buildEmailReply, buildSmsReplyBody } from "@/lib/contact-messages/reply-content";

export type MessageActionResult<T = { id: string }> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// Which moves staff may make (and why `booked` is never one) lives in
// @/lib/contact-messages/status-transitions, shared with the detail page and
// the bulk bar.

const StatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(STAFF_STATUS_TARGETS),
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
  status: StaffStatusTarget,
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

const BulkStatusSchema = z.object({
  entries: z
    .array(z.object({ id: z.string().uuid(), from: z.enum(CONTACT_MESSAGE_STATUSES) }))
    .min(1)
    .max(MAX_BULK_ROWS),
  to: z.enum(STAFF_STATUS_TARGETS),
});
const BULK_INPUT_ERROR = "Could not read the selection — refresh the inbox and try again.";

/**
 * The inbox bulk bar (spec 2026-09-25 §7). Each entry carries the status the
 * operator SAW; the server re-reads each message and writes one guarded
 * UPDATE per exact (status, handled_by, handled_at) it read, so a message
 * changed by anyone since — status or handler — is skipped and named, never
 * overwritten (the single action above reads then writes by id alone). The
 * same three columns as the single action change; every changed message gets
 * its own audit row carrying the batch id, the handler it had before and the
 * one handled_at this call stamped — exactly what the 10-minute Undo needs.
 */
export async function updateMessageStatusManyAction(input: unknown): Promise<BulkMessageResult> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };
  const parsed = BulkStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: BULK_INPUT_ERROR };
  const { to } = parsed.data;

  // First occurrence of an id wins.
  const fromOf = new Map<string, ContactMessageStatus>();
  for (const e of parsed.data.entries) if (!fromOf.has(e.id)) fromOf.set(e.id, e.from);
  const ids = [...fromOf.keys()];

  const skipped: Array<{ id: string; reason: string }> = [];
  const candidates = ids.filter((id) => {
    const from = fromOf.get(id)!;
    if (canTransition(from, to)) return true;
    skipped.push({ id, reason: notAllowedReason(from, to) });
    return false;
  });

  const supabase = await createClient();
  const current = new Map<string, { status: string; handled_by: string | null; handled_at: string | null }>();
  if (candidates.length > 0) {
    const { data, error } = await supabase
      .from("contact_messages")
      .select("id, status, handled_by, handled_at")
      .in("id", candidates);
    if (error) return { ok: false, error: translatePgError(error) };
    for (const r of data ?? []) current.set(r.id, r);
  }

  const writable: MessageWriteRow[] = [];
  for (const id of candidates) {
    const row = current.get(id);
    if (!row) skipped.push({ id, reason: MESSAGE_GONE_REASON });
    else if (row.status !== fromOf.get(id)) skipped.push({ id, reason: MESSAGE_CHANGED_REASON });
    else writable.push({ id, from: fromOf.get(id)!, handled_by: row.handled_by, handled_at: row.handled_at });
  }

  const batchId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const changed: MessageWriteRow[] = [];
  const erroredIds = new Set<string>();
  let firstError: { code?: string; message: string } | null = null;
  for (const group of groupMessagesForWrite(writable)) {
    let q = supabase
      .from("contact_messages")
      .update({ status: to, handled_by: session.user_id, handled_at: stamp })
      .in("id", group.ids)
      .eq("status", group.from);
    q = group.handledBy === null ? q.is("handled_by", null) : q.eq("handled_by", group.handledBy);
    q = group.handledAt === null ? q.is("handled_at", null) : q.eq("handled_at", group.handledAt);
    const { data, error } = await q.select("id");
    if (error) {
      console.error("bulk message status write failed", { ids: group.ids, error });
      firstError ??= error;
      for (const id of group.ids) erroredIds.add(id);
      continue;
    }
    const got = new Set((data ?? []).map((r) => r.id));
    for (const w of writable) if (got.has(w.id)) changed.push(w);
  }
  const changedSet = new Set(changed.map((c) => c.id));
  for (const w of writable) {
    if (changedSet.has(w.id)) continue;
    skipped.push({ id: w.id, reason: erroredIds.has(w.id) ? MESSAGE_WRITE_FAILED_REASON : MESSAGE_CHANGED_REASON });
  }

  if (changed.length > 0) {
    const { ip, ua } = await ipAndAgent();
    await Promise.all(
      changed.map((row) =>
        audit({
          actor_id: session.user_id,
          actor_type: "staff",
          action: "contact_message.status_changed",
          resource_type: "contact_message",
          resource_id: row.id,
          metadata: {
            from: row.from,
            to,
            previous_handled_by: row.handled_by,
            previous_handled_at: row.handled_at,
            handled_at: stamp,
            bulk_batch_id: batchId,
            bulk_batch_size: ids.length,
          },
          ip_address: ip,
          user_agent: ua,
        }),
      ),
    );
    revalidatePath("/staff/messages");
    for (const row of changed) revalidatePath(`/staff/messages/${row.id}`);
    revalidatePath("/staff", "layout");
  }
  if (firstError && changed.length === 0) return { ok: false, error: translatePgError(firstError) };

  // Every id sent lands in exactly one of changedIds / skipped, in input order.
  const reasonOf = new Map(skipped.map((s) => [s.id, s.reason]));
  return {
    ok: true,
    changedIds: ids.filter((id) => changedSet.has(id)),
    skipped: ids.filter((id) => reasonOf.has(id)).map((id) => ({ id, reason: reasonOf.get(id)! })),
    ...(changed.length > 0 ? { batchId } : {}),
  };
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

// Small structural shape shared by sendEmail's SendResult and sendSms's
// SmsResult — enough for outcomeFromSendResult to map either into a
// contact_message_replies outcome without caring about the provider-specific
// success `id` field.
interface SendOutcomeShape {
  ok: boolean;
  kind?: "error" | "skipped";
  error?: string;
  reason?: string;
}

function outcomeFromSendResult(result: SendOutcomeShape): {
  outcome: ReplyOutcome;
  detail: string | null;
} {
  if (result.ok) return { outcome: "sent", detail: null };
  if (result.kind === "skipped") {
    return { outcome: "skipped", detail: (result.reason ?? "").slice(0, 500) };
  }
  return { outcome: "failed", detail: (result.error ?? "").slice(0, 500) };
}

export async function sendMessageReplyAction(
  messageId: string,
  channel: ReplyChannel,
  body: string,
): Promise<MessageActionResult<{ outcome: ReplyOutcome; detail: string | null }>> {
  const { session, error: roleError } = await requireInboxStaff();
  if (!session) return { ok: false, error: roleError };

  const parsed = ReplyInputSchema.safeParse({ messageId, channel, body });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check your reply." };
  }

  const supabase = await createClient();
  const { data: message, error: loadError } = await supabase
    .from("contact_messages")
    .select("id, name, email, phone, subject, status")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (loadError || !message) {
    return { ok: false, error: "That message could not be found." };
  }

  // The destination is always the message's own contact info — never an
  // address the client hands us — so a spoofed form field can't redirect the
  // reply anywhere else.
  let sentTo: string;
  let sendResult: SendOutcomeShape;

  if (parsed.data.channel === "email") {
    if (!message.email) {
      return { ok: false, error: "This message has no email address to reply to." };
    }
    sentTo = message.email;
    const content = buildEmailReply({
      firstName: firstNameOf(message.name),
      subject: message.subject,
      staffText: parsed.data.body,
    });
    sendResult = await sendEmail({ to: sentTo, subject: content.subject, text: content.text, html: content.html });
  } else {
    const normalized = normalizePhPhone(message.phone);
    if (!normalized) {
      return { ok: false, error: "This message has no valid Philippine mobile number to text." };
    }
    sentTo = normalized;
    const smsBody = buildSmsReplyBody(parsed.data.body);
    sendResult = await sendSms({ to: normalized, message: smsBody });
  }

  const { outcome, detail } = outcomeFromSendResult(sendResult);

  const { error: insertError } = await supabase.from("contact_message_replies").insert({
    message_id: parsed.data.messageId,
    channel: parsed.data.channel,
    sent_to: sentTo,
    body: parsed.data.body,
    outcome,
    outcome_detail: detail,
    sent_by: session.user_id,
  });
  // The provider call has already happened. If nothing went out (skipped or
  // failed), a failed insert is safe to surface as an error — retrying sends
  // nothing twice. But if the reply WENT OUT, returning an error would invite
  // staff to press Send again and text/email the patient a second time, so
  // report the lost history row, carry on (status + audit), and say plainly
  // that it was sent.
  let historyNotSaved = false;
  if (insertError) {
    if (outcome !== "sent") {
      return { ok: false, error: translatePgError(insertError) };
    }
    historyNotSaved = true;
    await reportError({
      scope: "messages/reply-history-insert",
      error: new Error(insertError.message),
      metadata: { messageId: parsed.data.messageId, channel: parsed.data.channel, code: insertError.code },
    });
  }

  // Only a message still sitting at "new" moves to "replied" — never
  // downgrade a message that's already booked/closed/replied.
  if (outcome === "sent" && message.status === "new") {
    await supabase
      .from("contact_messages")
      .update({ status: "replied", handled_by: session.user_id, handled_at: new Date().toISOString() })
      .eq("id", parsed.data.messageId)
      .eq("status", "new");
  }

  const { ip, ua } = await ipAndAgent();
  // Never the reply body or the address it went to (RA 10173) — channel,
  // outcome and length only.
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "contact_message.reply_sent",
    resource_type: "contact_message",
    resource_id: parsed.data.messageId,
    metadata: {
      channel: parsed.data.channel,
      outcome,
      length: parsed.data.body.length,
      ...(historyNotSaved ? { history_saved: false } : {}),
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidateMessageSurfaces(parsed.data.messageId);
  return {
    ok: true,
    data: {
      outcome,
      detail: historyNotSaved
        ? "It was sent, but it could not be saved to the reply history. Don't send it again."
        : detail,
    },
  };
}
