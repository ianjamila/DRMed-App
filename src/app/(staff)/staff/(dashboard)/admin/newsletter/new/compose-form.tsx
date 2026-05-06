"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renderMarkdown } from "@/lib/newsletter/markdown";
import {
  sendCampaignAction,
  type CampaignResult,
} from "../actions";

interface Props {
  activeSubscriberCount: number;
}

export function ComposeForm({ activeSubscriberCount }: Props) {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(
    "Hello there!\n\nA quick note from drmed.ph:\n\n- New test available: …\n- Schedule update: …\n\n[Book an appointment](https://drmed.ph/schedule)\n",
  );
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<
    CampaignResult | null,
    FormData
  >(sendCampaignAction, null);

  const previewHtml = renderMarkdown(body || "_Preview will appear here._");

  return (
    <form
      action={formAction}
      className="grid gap-6"
      onSubmit={(e) => {
        if (!confirming) {
          e.preventDefault();
          setConfirming(true);
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="subject">Subject</Label>
        <Input
          id="subject"
          name="subject"
          required
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. New thyroid panel + 10% promo this November"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="body_md">Body (markdown)</Label>
          <textarea
            id="body_md"
            name="body_md"
            required
            rows={16}
            maxLength={50_000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 font-mono text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Preview</Label>
          <div className="min-h-[24rem] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm leading-relaxed">
            <p className="font-semibold text-[color:var(--color-brand-navy)]">
              {subject || "(no subject yet)"}
            </p>
            <hr className="my-3 border-[color:var(--color-brand-bg-mid)]" />
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
            <hr className="my-3 border-[color:var(--color-brand-bg-mid)]" />
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Recipients will also see a one-click unsubscribe link in the
              footer of the actual email.
            </p>
          </div>
        </div>
      </div>

      {confirming ? (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Confirm send?</p>
          <p className="mt-1">
            This will email <strong>{activeSubscriberCount}</strong> subscriber
            {activeSubscriberCount === 1 ? "" : "s"} immediately. The
            campaign cannot be unsent.
          </p>
        </div>
      ) : null}

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={pending || activeSubscriberCount === 0}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending
            ? "Sending…"
            : confirming
              ? `Yes, send to ${activeSubscriberCount}`
              : "Send campaign"}
        </Button>
        {confirming ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            Back to edit
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
            disabled={pending}
          >
            Cancel
          </Button>
        )}
      </div>

      {activeSubscriberCount === 0 ? (
        <p className="text-sm text-amber-700">
          There are no active subscribers — there&apos;s nothing to send yet.
        </p>
      ) : null}
    </form>
  );
}
