"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { StableInput } from "@/components/forms/stable-fields";
import {
  subscribeAction,
  type SubscribeResult,
} from "@/app/(marketing)/newsletter/actions";
import type { SubscriberSource } from "@/lib/validations/newsletter";

interface Props {
  source: SubscriberSource;
  variant?: "footer" | "page";
}

export function NewsletterForm({ source, variant = "footer" }: Props) {
  const [state, formAction, pending] = useActionState<
    SubscribeResult | null,
    FormData
  >(subscribeAction, null);

  if (state?.ok) {
    return (
      <p
        className={
          variant === "footer"
            ? "text-sm text-[color:var(--color-brand-cyan)]"
            : "rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900"
        }
      >
        {state.alreadyActive
          ? "You&apos;re already on the list — thanks!"
          : "Subscribed. Watch your inbox for updates."}
      </p>
    );
  }

  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="source" value={source} />
      {/* Honeypot for naïve bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        className="hidden"
        aria-hidden="true"
      />

      <div
        className={
          variant === "footer"
            ? "flex flex-col gap-2 sm:flex-row"
            : "grid gap-2 sm:grid-cols-[1fr_auto]"
        }
      >
        <StableInput
          type="email"
          name="email"
          required
          maxLength={254}
          placeholder="you@example.com"
          aria-label="Email address"
          className={
            variant === "footer"
              ? "bg-white text-[color:var(--color-brand-navy)]"
              : ""
          }
        />
        <Button
          type="submit"
          disabled={pending}
          className={
            variant === "footer"
              ? "bg-[color:var(--color-brand-cyan)] text-[color:var(--color-brand-navy)] hover:bg-white"
              : "bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
          }
        >
          {pending ? "Subscribing…" : "Subscribe"}
        </Button>
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-300" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
