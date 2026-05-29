// src/components/consent/consent-notice.tsx
import {
  CONSENT_NOTICE_SECTIONS,
  CONSENT_STATEMENT,
  CURRENT_CONSENT_NOTICE_VERSION,
} from "@/lib/consent/notice";

export function ConsentNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "text-xs leading-relaxed" : "text-sm leading-relaxed"}>
      <div className="grid gap-2 sm:grid-cols-2">
        {CONSENT_NOTICE_SECTIONS.map((s) => (
          <p key={s.heading} className="text-[color:var(--color-brand-text-mid)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {s.heading}.
            </span>{" "}
            {s.body}
          </p>
        ))}
      </div>
      <p className="mt-3 rounded-r-lg border-l-4 border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-4 py-3 text-[color:var(--color-brand-text)]">
        {CONSENT_STATEMENT}
      </p>
      <p className="mt-2 text-[10px] uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
        Notice version {CURRENT_CONSENT_NOTICE_VERSION}
      </p>
    </div>
  );
}
