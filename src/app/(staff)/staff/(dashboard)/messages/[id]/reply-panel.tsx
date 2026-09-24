"use client";

// Reply panel for the Website Messages detail page. Sends an email or text
// message reply from inside the app via sendMessageReplyAction. The
// destination (`emailTo`/`smsTo`) is computed server-side from the message's
// own contact info and passed in as read-only props — nothing here lets
// staff type in a different address, so a spoofed field can't redirect a
// reply meant for this sender.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  REPLY_BODY_MAX,
  REPLY_CHANNEL_LABEL,
  REPLY_OUTCOME_LABEL,
  REPLY_SMS_MAX,
  type ReplyChannel,
  type ReplyOutcome,
} from "@/lib/contact-messages/labels";
import { replyTemplates, smsSegmentCount } from "@/lib/contact-messages/reply-content";
import { sendMessageReplyAction } from "../actions";

interface Props {
  messageId: string;
  firstName: string;
  emailTo: string | null;
  /** Already normalized (normalizePhPhone), or null when the message has no
   * phone or it isn't a recognizable PH mobile number. */
  smsTo: string | null;
}

export function ReplyPanel({ messageId, firstName, emailTo, smsTo }: Props) {
  const router = useRouter();
  const hasEmail = !!emailTo;
  const hasSms = !!smsTo;

  const [channel, setChannel] = useState<ReplyChannel>(hasEmail ? "email" : "sms");
  const [body, setBody] = useState("");
  const [pending, startSend] = useTransition();
  const [result, setResult] = useState<{ outcome: ReplyOutcome; detail: string | null } | null>(null);

  const templates = useMemo(() => replyTemplates(firstName), [firstName]);

  if (!hasEmail && !hasSms) {
    return (
      <div>
        <h2 className="mb-2 font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">
          Reply
        </h2>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          This message has no email address or a phone number we can text. Call them if a number is
          shown above, or check for a way to reach them another way.
        </p>
      </div>
    );
  }

  const maxLen = channel === "sms" ? REPLY_SMS_MAX : REPLY_BODY_MAX;
  const to = channel === "email" ? emailTo : smsTo;
  const overLimit = body.length > maxLen;
  const canSend = body.trim().length > 0 && !overLimit && !pending;

  function fireSend() {
    setResult(null);
    startSend(async () => {
      const res = await sendMessageReplyAction(messageId, channel, body);
      if (!res.ok) {
        alert(res.error);
        return;
      }
      setResult(res.data);
      setBody("");
      router.refresh();
    });
  }

  function applyTemplate(templateBody: string) {
    setBody(templateBody);
  }

  return (
    <div className="space-y-3">
      <h2 className="font-heading text-base font-extrabold text-[color:var(--color-brand-navy)]">Reply</h2>

      {hasEmail && hasSms ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={channel === "email" ? "brand" : "outline"}
            onClick={() => setChannel("email")}
          >
            {REPLY_CHANNEL_LABEL.email}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={channel === "sms" ? "brand" : "outline"}
            onClick={() => setChannel("sms")}
          >
            {REPLY_CHANNEL_LABEL.sms}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        To: <span className="font-semibold text-[color:var(--color-brand-text-mid)]">{to}</span>
      </p>

      <div className="flex flex-wrap gap-2">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => applyTemplate(t.body)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-xs font-semibold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            {t.label}
          </button>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Write your reply…"
        className="w-full rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs ${overLimit ? "font-semibold text-red-600" : "text-[color:var(--color-brand-text-soft)]"}`}>
          {body.length}/{maxLen}
          {channel === "sms" ? ` · ${smsSegmentCount(body)} text segment${smsSegmentCount(body) === 1 ? "" : "s"}` : ""}
        </span>
        <Button type="button" size="sm" variant="brand" disabled={!canSend} onClick={fireSend}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
      </div>

      {result ? (
        <p className="text-xs font-semibold text-[color:var(--color-brand-navy)]">
          {REPLY_OUTCOME_LABEL[result.outcome]}
          {result.detail ? <span className="ml-1 font-normal text-[color:var(--color-brand-text-soft)]">— {result.detail}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
