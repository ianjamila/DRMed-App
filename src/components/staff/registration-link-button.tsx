"use client";

import * as React from "react";
import { QrCode } from "@/components/ui/qr-code";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

// Reception-facing: reveal a QR + copyable link to the public /register page so
// a patient can self-register on their own phone. Reuses the PR1 QrCode component.
export function RegistrationLinkButton({ url }: { url: string }) {
  const [open, setOpen] = React.useState(false);
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
    <div className="relative">
      <Button type="button" variant="outline" onClick={() => setOpen((v) => !v)}>
        Registration link
      </Button>
      {open && (
        <Panel className="absolute right-0 z-40 mt-2 flex w-64 flex-col items-center gap-2 p-4 shadow-lg">
          <p className="text-xs font-semibold text-[color:var(--color-brand-text-mid)]">Have the patient scan to self-register</p>
          <QrCode value={url} size={170} />
          <span className="font-mono text-[10px] break-all text-[color:var(--color-brand-text-soft)]">{url}</span>
          <Button type="button" size="sm" variant="outline" onClick={copy} className="w-full">
            {copied ? "Copied!" : "Copy link"}
          </Button>
          <a
            href="/register-poster"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline"
          >
            Open printable poster →
          </a>
        </Panel>
      )}
    </div>
  );
}
