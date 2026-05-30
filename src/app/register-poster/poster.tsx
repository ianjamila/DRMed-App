"use client";

import { QrCode } from "@/components/ui/qr-code";
import { SITE, CONTACT } from "@/lib/marketing/site";

// Print-optimized poster for the reception desk. Wording is inviting, not
// coercive — registration is optional; walking in is always fine.
export function RegisterPoster({ url }: { url: string }) {
  const display = url.replace(/^https?:\/\//, "");
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-5 p-8 text-center">
      <button
        type="button"
        onClick={() => window.print()}
        className="no-print fixed top-4 right-4 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        Print
      </button>

      {/* Brand: logo + official slogan */}
      <div className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
        <img src="/logo.png" alt={SITE.name} className="h-20 w-auto" />
        <p className="text-base font-semibold italic text-[color:var(--color-brand-cyan)]">
          {SITE.tagline}
        </p>
      </div>

      <h1 className="font-[family-name:var(--font-heading)] text-4xl leading-tight font-extrabold text-[color:var(--color-brand-navy)]">
        Skip the counter form
      </h1>
      <p className="text-lg text-[color:var(--color-brand-text-mid)]">
        Scan to pre-register and get your DRM-ID in under a minute.
      </p>

      {/* QR in a framed card so it reads as the focal point */}
      <div className="rounded-2xl border-2 border-[color:var(--color-brand-bg-mid)] bg-white p-5 shadow-sm">
        <QrCode value={url} size={280} />
      </div>
      <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">{display}</p>

      <ol className="mt-1 max-w-xs list-decimal space-y-1 pl-5 text-left text-sm text-[color:var(--color-brand-text-mid)]">
        <li>Scan the QR with your phone camera.</li>
        <li>Fill in your details &amp; accept the privacy notice.</li>
        <li>We email your DRM-ID — show it at the counter.</li>
      </ol>

      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Prefer not to? No problem — just walk in. Registration is always optional.
      </p>

      {/* Contact footer — makes the poster a complete, standalone print */}
      <div className="mt-2 w-full border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">{SITE.name}</p>
        <p>{CONTACT.address.full}</p>
        <p>
          {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
        </p>
      </div>

      <style>{`@media print { .no-print { display: none !important; } @page { margin: 1.2cm; } }`}</style>
    </div>
  );
}
