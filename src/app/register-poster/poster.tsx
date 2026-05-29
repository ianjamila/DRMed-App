"use client";

import { QrCode } from "@/components/ui/qr-code";

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

      <p className="text-sm font-bold uppercase tracking-[0.2em] text-[color:var(--color-brand-cyan)]">
        DRMed Clinic &amp; Laboratory
      </p>
      <h1 className="font-[family-name:var(--font-heading)] text-4xl leading-tight font-extrabold text-[color:var(--color-brand-navy)]">
        Skip the counter form
      </h1>
      <p className="text-lg text-[color:var(--color-brand-text-mid)]">
        Scan to pre-register and get your DRM-ID in under a minute.
      </p>

      <QrCode value={url} size={300} />
      <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">{display}</p>

      <ol className="mt-1 max-w-xs list-decimal space-y-1 pl-5 text-left text-sm text-[color:var(--color-brand-text-mid)]">
        <li>Scan the QR with your phone camera.</li>
        <li>Fill in your details &amp; accept the privacy notice.</li>
        <li>We email your DRM-ID — show it at the counter.</li>
      </ol>

      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Prefer not to? No problem — just walk in. Registration is always optional.
      </p>

      <style>{`@media print { .no-print { display: none !important; } @page { margin: 1.4cm; } }`}</style>
    </div>
  );
}
