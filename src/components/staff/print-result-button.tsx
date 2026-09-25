"use client";

import { useState } from "react";

interface Props {
  // Any test_request on the result. A consolidated chemistry report is one
  // PDF shared by every test in the panel, so one member's id prints it all.
  testRequestId: string;
  size?: "default" | "compact";
}

/**
 * Prints a released result PDF straight from the list or the visit page. It
 * fetches the file from the staff PDF route with `?print=1` (which audits
 * `result.printed_staff` — a request to print, the disclosure RA 10173 cares
 * about, not proof that paper came out) and opens it in a new tab, where the
 * browser's PDF viewer prints it (its Print button, or Ctrl/Cmd + P).
 *
 * Why a tab and not an off-screen iframe + `print()`: no browser lets a page
 * script a framed PDF any more. Chrome/Edge host it in the PDF viewer's own
 * cross-origin frame, so `contentWindow.print()` throws (verified in headed
 * Chrome 153, 2026-09-25); Safari silently does nothing; Firefox is
 * unreliable. Opening the print dialog directly would need a PDF renderer
 * (pdf.js) in the page.
 *
 * The tab is reserved SYNCHRONOUSLY in the click handler: a `window.open`
 * after the `await` has lost the click's user activation and a popup blocker
 * eats it. Fetching first (rather than pointing the tab at the route) keeps a
 * refusal — not released, no file — as a message here instead of raw JSON in
 * a tab. If the tab is blocked anyway, the button offers an "Open the PDF to
 * print" link — a fresh click, which no blocker refuses.
 */
export function PrintResultButton({ testRequestId, size = "default" }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The fallback link's target, when the reserved tab was blocked.
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  async function handlePrint() {
    setPending(true);
    setError(null);
    setOpenUrl(null);
    // Must happen before the first await — see the component comment.
    const tab = window.open("", "_blank");
    try {
      const res = await fetch(`/staff/results/${testRequestId}/pdf?print=1`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        tab?.close();
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Couldn't load the result. Try again.");
        return;
      }
      // Never revoked: the tab (or the fallback link) still reads this URL
      // after the next click or an unmount, and the browser frees it when
      // this page unloads.
      const url = URL.createObjectURL(await res.blob());
      if (tab && !tab.closed) {
        tab.location.href = url;
      } else {
        // The blocker ate the reserved tab: hand over a real link instead.
        setOpenUrl(url);
      }
    } catch {
      tab?.close();
      setError("Couldn't load the result. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const text = size === "compact" ? "text-[10px]" : "text-xs";
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handlePrint}
        disabled={pending}
        className={`${text} inline-flex items-center gap-1 rounded-md border border-[color:var(--color-brand-cyan)] px-2 py-1 font-bold text-[color:var(--color-brand-cyan)] transition-colors hover:bg-[color:var(--color-brand-cyan)] hover:text-white disabled:cursor-wait disabled:opacity-60`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9V2h12v7" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <path d="M6 14h12v8H6z" />
        </svg>
        {pending ? "Preparing…" : "Print result"}
      </button>
      {openUrl ? (
        <a
          href={openUrl}
          target="_blank"
          rel="noopener"
          className={`${text} font-bold text-[color:var(--color-brand-cyan)] underline`}
        >
          Open the PDF to print →
        </a>
      ) : null}
      {error ? (
        <span role="alert" className={`${text} max-w-48 text-right text-red-700`}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
