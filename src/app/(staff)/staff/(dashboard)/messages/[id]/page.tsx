import { cache } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { Panel } from "@/components/ui/panel";
import { manilaDateTime } from "@/lib/dates/manila";
import { appointmentStatusLabel } from "@/lib/appointments/labels";
import { attributionCampaignLabel } from "@/lib/appointments/source";
import type { Attribution } from "@/lib/analytics/attribution";
import {
  CONTACT_MESSAGE_KIND_LABEL,
  CONTACT_MESSAGE_STATUS_HINT,
  contactMessageStatusLabel,
  isContactMessageKind,
  isContactMessageStatus,
  isReplyChannel,
  isReplyOutcome,
  REPLY_CHANNEL_LABEL,
  REPLY_OUTCOME_LABEL,
} from "@/lib/contact-messages/labels";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { normalizePhPhone } from "@/lib/notifications/sms";
import { MessageActionsPanel } from "./message-actions";
import { ReplyPanel } from "./reply-panel";

const DETAIL_NAME = "Website Message";

const STATUS_STYLE: Record<string, string> = {
  new: "bg-sky-100 text-sky-900",
  replied: "bg-amber-100 text-amber-900",
  booked: "bg-emerald-100 text-emerald-900",
  closed: "bg-slate-200 text-slate-700",
};

// Shared between generateMetadata and the page — React `cache()` de-dupes
// the query within one request.
const loadMessage = cache(async (id: string) => {
  const supabase = await createClient();
  return supabase
    .from("contact_messages")
    .select(
      "id, name, email, phone, subject, message, status, kind, staff_notes, created_at, handled_by, handled_at, linked_appointment_id, attribution",
    )
    .eq("id", id)
    .maybeSingle();
});

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(DETAIL_NAME, async () => {
    const { data, error } = await loadMessage(id);
    return error || !data ? null : data.name;
  });
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}
function smsHref(phone: string): string {
  return `sms:${phone.replace(/[^0-9+]/g, "")}`;
}
function mailtoHref(email: string): string {
  return `mailto:${email}?subject=${encodeURIComponent("Re: your message to DR Med")}`;
}

const ATTRIBUTION_ROWS: ReadonlyArray<{ key: keyof Attribution; label: string }> = [
  { key: "utm_source", label: "Source" },
  { key: "utm_medium", label: "Medium" },
  { key: "utm_campaign", label: "Campaign" },
  { key: "utm_content", label: "Content" },
  { key: "utm_term", label: "Term" },
  { key: "landing_path", label: "Landing page" },
];

export default async function MessageDetailPage({ params }: Props) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const { id } = await params;
  const { data: message, error } = await loadMessage(id);
  if (error || !message) notFound();

  const status = isContactMessageStatus(message.status) ? message.status : "new";
  const kind = isContactMessageKind(message.kind) ? message.kind : "general";
  const attribution = (message.attribution ?? null) as Attribution | null;
  const hasAttribution = !!attribution && ATTRIBUTION_ROWS.some((r) => !!attribution[r.key]);

  const supabase = await createClient();

  const [handledByProfile, linkedAppointment, repliesResp] = await Promise.all([
    message.handled_by
      ? supabase.from("staff_profiles").select("full_name").eq("id", message.handled_by).maybeSingle()
      : Promise.resolve({ data: null }),
    message.linked_appointment_id
      ? supabase
          .from("appointments")
          .select("id, scheduled_at, status, walk_in_name, patients ( first_name, last_name )")
          .eq("id", message.linked_appointment_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("contact_message_replies")
      .select("id, channel, sent_to, body, outcome, outcome_detail, sent_by, created_at")
      .eq("message_id", id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
  ]);

  const handledByName = handledByProfile?.data?.full_name ?? null;

  const apptRow = linkedAppointment?.data ?? null;
  const apptPatient = apptRow
    ? Array.isArray(apptRow.patients)
      ? apptRow.patients[0]
      : apptRow.patients
    : null;
  const apptSearchName = apptPatient
    ? `${apptPatient.first_name} ${apptPatient.last_name}`
    : (apptRow?.walk_in_name ?? message.name);

  const replies = repliesResp.data ?? [];
  const replySenderIds = [...new Set(replies.map((r) => r.sent_by))];
  const { data: replySenders } =
    replySenderIds.length > 0
      ? await supabase.from("staff_profiles").select("id, full_name").in("id", replySenderIds)
      : { data: [] as Array<{ id: string; full_name: string }> };
  const replySenderName = new Map((replySenders ?? []).map((p) => [p.id, p.full_name]));

  const smsTo = normalizePhPhone(message.phone);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-4">
        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          {DETAIL_NAME}
        </p>
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {message.name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Received {manilaDateTime(message.created_at)}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel className="p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[status] ?? ""}`}
              >
                {contactMessageStatusLabel(status)}
              </span>
              <span className="rounded-md bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-semibold text-[color:var(--color-brand-text-mid)]">
                {CONTACT_MESSAGE_KIND_LABEL[kind]}
              </span>
            </div>
            <p className="mb-4 text-xs text-[color:var(--color-brand-text-soft)]">
              {CONTACT_MESSAGE_STATUS_HINT[status]}
            </p>
            {message.subject ? (
              <p className="mb-2 text-sm">
                <span className="font-semibold text-[color:var(--color-brand-navy)]">Subject:</span>{" "}
                {message.subject}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--color-brand-text-mid)]">
              {message.message}
            </p>
          </Panel>

          {hasAttribution ? (
            <Panel className="p-5">
              <h2 className="mb-3 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
                How they found us
              </h2>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                {ATTRIBUTION_ROWS.filter((r) => !!attribution?.[r.key]).map((r) => (
                  <div key={r.key}>
                    <dt className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      {r.label}
                    </dt>
                    <dd className="font-semibold text-[color:var(--color-brand-text-mid)]">
                      {attribution?.[r.key]}
                    </dd>
                  </div>
                ))}
              </dl>
              {attributionCampaignLabel(attribution) ? (
                <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
                  Ad campaign: <span className="font-semibold">{attributionCampaignLabel(attribution)}</span>
                </p>
              ) : null}
            </Panel>
          ) : null}

          {message.linked_appointment_id ? (
            <Panel className="p-5">
              <h2 className="mb-3 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
                Booked appointment
              </h2>
              {apptRow ? (
                <div className="text-sm text-[color:var(--color-brand-text-mid)]">
                  <p>
                    {apptRow.scheduled_at ? manilaDateTime(apptRow.scheduled_at) : "Walk-in (no fixed time)"}
                    {" · "}
                    <span className="font-semibold">{appointmentStatusLabel(apptRow.status)}</span>
                  </p>
                  <Link
                    href={`/staff/appointments?q=${encodeURIComponent(apptSearchName)}`}
                    className="mt-2 inline-block text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                  >
                    Find it in Appointments →
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-[color:var(--color-brand-text-soft)]">
                  The linked appointment could not be loaded.
                </p>
              )}
            </Panel>
          ) : null}

          <Panel className="p-5">
            <ReplyPanel
              messageId={message.id}
              firstName={firstNameOf(message.name)}
              emailTo={message.email}
              smsTo={smsTo}
            />
          </Panel>

          {replies.length > 0 ? (
            <Panel className="p-5">
              <h2 className="mb-3 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
                Reply history
              </h2>
              <ul className="space-y-4">
                {replies.map((r) => {
                  const replyChannel = isReplyChannel(r.channel) ? r.channel : "email";
                  const replyOutcome = isReplyOutcome(r.outcome) ? r.outcome : "failed";
                  return (
                    <li key={r.id} className="border-t border-[color:var(--color-brand-bg-mid)] pt-3 first:border-t-0 first:pt-0">
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {manilaDateTime(r.created_at)} · {REPLY_CHANNEL_LABEL[replyChannel]} to{" "}
                        <span className="font-semibold text-[color:var(--color-brand-text-mid)]">{r.sent_to}</span>
                        {" · "}
                        {replySenderName.get(r.sent_by) ?? "a staff member"}
                        {" · "}
                        <span className="font-semibold">{REPLY_OUTCOME_LABEL[replyOutcome]}</span>
                        {r.outcome_detail ? ` (${r.outcome_detail})` : ""}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--color-brand-text-mid)]">
                        {r.body}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel className="p-5">
            <h2 className="mb-3 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
              Contact
            </h2>
            <ul className="space-y-2 text-sm">
              {message.phone ? (
                <li>
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">{message.phone}</p>
                  <p className="mt-0.5 flex gap-3 text-xs">
                    <a href={telHref(message.phone)} className="text-[color:var(--color-brand-cyan)] hover:underline">
                      Call
                    </a>
                    <a href={smsHref(message.phone)} className="text-[color:var(--color-brand-cyan)] hover:underline">
                      Text
                    </a>
                  </p>
                </li>
              ) : null}
              {message.email ? (
                <li>
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">{message.email}</p>
                  <p className="mt-0.5 text-xs">
                    <a href={mailtoHref(message.email)} className="text-[color:var(--color-brand-cyan)] hover:underline">
                      Email
                    </a>
                  </p>
                </li>
              ) : null}
              {!message.phone && !message.email ? (
                <li className="text-[color:var(--color-brand-text-soft)]">No phone or email on file.</li>
              ) : null}
            </ul>
          </Panel>

          <Panel className="p-5">
            <h2 className="mb-2 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
              Status
            </h2>
            <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
              {message.handled_by
                ? `Last changed by ${handledByName ?? "a staff member"} · ${manilaDateTime(message.handled_at!)}`
                : "No one has changed the status yet."}
            </p>
            <MessageActionsPanel
              messageId={message.id}
              status={status}
              kind={kind}
              staffNotes={message.staff_notes ?? ""}
              firstName={firstNameOf(message.name)}
              hasLinkedAppointment={!!message.linked_appointment_id}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
