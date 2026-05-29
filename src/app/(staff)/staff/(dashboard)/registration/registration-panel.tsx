"use client";

import * as React from "react";
import { QrCode } from "@/components/ui/qr-code";
import { Button } from "@/components/ui/button";

// Inline registration resources for the dedicated staff page: the QR shown
// directly (not behind a popover like the appointments-header button), the
// shareable link with copy, and a link to the printable desk poster.
export function RegistrationPanel({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 text-center">
      <QrCode value={url} size={220} />
      <span className="font-mono text-xs break-all text-[color:var(--color-brand-text-soft)]">{url}</span>
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <Button type="button" variant="outline" onClick={copy} className="flex-1">
          {copied ? "Copied!" : "Copy link"}
        </Button>
        <a
          href="/register-poster"
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-center text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Print poster →
        </a>
      </div>
    </div>
  );
}
