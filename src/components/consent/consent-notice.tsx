// src/components/consent/consent-notice.tsx
import {
  CONSENT_NOTICE_SECTIONS,
  CONSENT_STATEMENT,
  CURRENT_CONSENT_NOTICE_VERSION,
  consentNoticeText,
} from "@/lib/consent/notice";

// `version` renders the archived wording of an older notice (the signed-form
// page passes the version the consent was agreed to). Omitted, or a version
// with no archived text, renders the current notice.
export function ConsentNotice({
  compact = false,
  version,
}: {
  compact?: boolean;
  version?: string | null;
}) {
  const archived = version ? consentNoticeText(version) : null;
  const sections = archived?.sections ?? CONSENT_NOTICE_SECTIONS;
  const statement = archived?.statement ?? CONSENT_STATEMENT;
  const shownVersion = archived ? version : CURRENT_CONSENT_NOTICE_VERSION;
  return (
    <div className={compact ? "text-xs leading-relaxed" : "text-sm leading-relaxed"}>
      <div className="grid gap-2 sm:grid-cols-2">
        {sections.map((s) => (
          <p key={s.heading} className="text-[color:var(--color-brand-text-mid)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {s.heading}.
            </span>{" "}
            {s.body}
          </p>
        ))}
      </div>
      <p className="mt-3 rounded-r-lg border-l-4 border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-4 py-3 text-[color:var(--color-brand-text)]">
        {statement}
      </p>
      <p className="mt-2 text-[10px] uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
        Notice version {shownVersion}
      </p>
    </div>
  );
}
