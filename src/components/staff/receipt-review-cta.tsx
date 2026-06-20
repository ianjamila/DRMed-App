import { QrCode } from "@/components/ui/qr-code";

// Compact, print-safe review nudge for the bottom of a printed receipt.
// Small QR (keeps a single-visit slip on one A5 page) + neutral, non-incentive
// copy (Google prohibits incentivized reviews). `url` is the on-domain
// /review?src=receipt link, built by the receipt page from the request host.
export function ReceiptReviewCta({ url }: { url: string }) {
  const display = url.replace(/^https?:\/\//, "").replace(/\?.*$/, "");
  return (
    <div className="mt-6 flex items-center gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4 text-left print:mt-3 print:break-inside-avoid print:p-2">
      <QrCode value={url} size={88} className="shrink-0 p-2" />
      <div>
        <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          Happy with your visit?
        </p>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Scan to leave us a Google review{" "}
          <span aria-hidden="true">★★★★★</span>
        </p>
        <p className="mt-0.5 font-mono text-[10px] break-all text-[color:var(--color-brand-text-soft)]">
          {display}
        </p>
      </div>
    </div>
  );
}
