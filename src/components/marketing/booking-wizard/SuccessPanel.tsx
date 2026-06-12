"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Booking confirmation. An ECG line draws, resolves into a ring, then a green
 * check (CSS transitions gated by the `.go` class — see globals.css; reduced
 * motion shows them fully drawn). Surfaces the real DRM-ID + status copy keyed
 * off `pending_callback`. No PII is persisted client-side.
 */
export function SuccessPanel({
  drmId,
  serviceSummary,
  scheduledAt,
  pendingCallback,
  isPortalContext,
}: {
  drmId: string;
  serviceSummary: string;
  scheduledAt: string | null;
  pendingCallback: boolean;
  isPortalContext: boolean;
}) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const whenLabel = scheduledAt
    ? new Date(scheduledAt).toLocaleString("en-PH", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Asia/Manila",
      })
    : null;

  return (
    <div className={`wizard-success ${go ? "go" : ""} text-center`}>
      <svg
        className="mx-auto block h-[110px] w-[min(420px,90%)] overflow-visible"
        viewBox="0 0 420 110"
        aria-hidden="true"
      >
        <path
          className="wizard-suc-ecg"
          pathLength={1}
          d="M20,55 L150,55 168,55 178,28 190,82 202,22 214,80 224,55 250,55 400,55"
        />
        <circle className="wizard-suc-ring" pathLength={1} cx="210" cy="55" r="34" />
        <path
          className="wizard-suc-check"
          pathLength={1}
          d="M194,55 L206,67 228,42"
        />
      </svg>

      <h1 className="mt-4 font-[family-name:var(--font-display)] text-[clamp(28px,6vw,38px)] font-normal leading-[1.1] text-[color:var(--color-brand-navy)]">
        {pendingCallback ? (
          <>
            Request <span className="italic text-[color:var(--color-brand-cyan)]">received.</span>
          </>
        ) : (
          <>
            Booking <span className="italic text-[color:var(--color-brand-cyan)]">confirmed.</span>
          </>
        )}
      </h1>

      <p className="mx-auto mt-3 max-w-[460px] text-[14.5px] text-[color:var(--color-ink-mid)]">
        {serviceSummary}
        {whenLabel ? ` · ${whenLabel}` : ""}
      </p>

      {pendingCallback ? (
        <p className="mx-auto mt-3 max-w-[460px] text-[13.5px] text-[color:var(--color-ink-soft)]">
          We&apos;ll call you within one working day to confirm a time and any
          other details.
        </p>
      ) : null}

      {isPortalContext ? (
        <p className="mt-6 text-[14px] text-[color:var(--color-ink-mid)]">
          A confirmation has been sent to the contact info on your file.{" "}
          <Link href="/portal" className="font-bold text-[color:var(--color-brand-cyan-text)] hover:underline">
            Back to portal →
          </Link>
        </p>
      ) : drmId ? (
        <div className="mx-auto mt-6 max-w-[460px] rounded-[18px] border border-[color:var(--color-warm-line-soft)] bg-white p-5 text-left text-sm shadow-[var(--shadow-warm-sm)]">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-ink-soft)]">
            Your DRM-ID
          </p>
          <p className="mt-2">
            <span className="inline-block rounded-full bg-[rgba(8,168,226,0.10)] px-5 py-2 font-mono text-[15px] font-bold tracking-[0.1em] text-[color:var(--color-brand-navy)]">
              {drmId}
            </span>
          </p>
          <p className="mt-3 text-xs text-[color:var(--color-ink-soft)]">
            Save this. After your visit, your Secure PIN is printed on the
            receipt — both are required to access results online.
          </p>
          <p className="mt-2 text-xs text-[color:var(--color-ink-soft)]">
            Next visit, choose &ldquo;Yes, I have a DRM-ID&rdquo; to skip
            re-entering your details.
          </p>
        </div>
      ) : null}
    </div>
  );
}
