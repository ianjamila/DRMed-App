"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  readCookieFromHeader,
  parseConsentChoice,
  type ConsentChoice,
} from "@/lib/analytics/consent";
import { recordCookieConsent } from "@/app/(marketing)/consent-actions";

// Opt-in / strict consent for the public marketing site.
//
// Consent is resolved on the CLIENT, from document.cookie, rather than by
// reading cookies() in the marketing layout. Reading cookies server-side in a
// layout is a request-time API and would force every marketing page — home,
// services, physicians, packages — from static to dynamic rendering, which we
// are not willing to pay for SEO reasons.
//
// document.cookie is an external store, so it is read through
// useSyncExternalStore rather than an on-mount effect: the server snapshot is
// "unresolved", which renders no banner during SSR and hydration, and the real
// value lands immediately afterwards. Visitors who already answered therefore
// never see the banner flash, and nothing tracks until a "granted" cookie has
// positively been read.

// "none" = resolved, but no decision on record.
type ConsentSnapshot = "unresolved" | "none" | ConsentChoice;

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

// Only this module writes the consent cookie, so a manual notification after
// each write is sufficient — there is no cookie-change event to subscribe to.
function emitConsentChange(): void {
  for (const listener of listeners) listener();
}

function getConsentSnapshot(): ConsentSnapshot {
  return (
    parseConsentChoice(readCookieFromHeader(document.cookie, CONSENT_COOKIE_NAME)) ?? "none"
  );
}

function getServerConsentSnapshot(): ConsentSnapshot {
  return "unresolved";
}

type ConsentState = ConsentChoice | null | undefined;

interface ConsentContextValue {
  // undefined = not resolved yet, null = no decision on record.
  choice: ConsentState;
  granted: boolean;
  accept: () => void;
  decline: () => void;
  // Reopens the banner so a visitor can change their mind (footer link).
  reopen: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function useCookieConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    throw new Error("useCookieConsent must be used inside <CookieConsentProvider>");
  }
  return ctx;
}

export function CookieConsentProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getConsentSnapshot,
    getServerConsentSnapshot,
  );
  const [reopened, setReopened] = useState(false);

  const choice: ConsentState =
    snapshot === "unresolved" ? undefined : snapshot === "none" ? null : snapshot;

  const persist = useCallback((next: ConsentChoice) => {
    // Write client-side first so the banner dismisses (and, on accept, the
    // Pixel mounts) immediately instead of after the server round trip. The
    // Server Action below re-sets the same value authoritatively and, on
    // decline, clears the HttpOnly attribution cookie that JS cannot touch.
    document.cookie =
      `${CONSENT_COOKIE_NAME}=${next}; path=/; max-age=${CONSENT_MAX_AGE_SECONDS}; samesite=lax` +
      (window.location.protocol === "https:" ? "; secure" : "");
    emitConsentChange();
    setReopened(false);
    void recordCookieConsent(next);
  }, []);

  const accept = useCallback(() => persist("granted"), [persist]);

  const wasGranted = snapshot === "granted";
  const decline = useCallback(() => {
    persist("denied");
    // The Server Action clears _fbp/_fbc, but fbq may already be loaded in this
    // tab and would keep its in-memory state. A reload guarantees the page
    // continues without the Pixel.
    if (wasGranted) window.location.reload();
  }, [persist, wasGranted]);

  const reopen = useCallback(() => setReopened(true), []);

  const value = useMemo<ConsentContextValue>(
    () => ({ choice, granted: choice === "granted", accept, decline, reopen }),
    [choice, accept, decline, reopen],
  );

  // Show while no decision is on record, or when explicitly reopened. Never
  // while consent is still unresolved (choice === undefined) — that would
  // flash the banner at visitors who already answered.
  const visible = reopened || choice === null;

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {visible ? <CookieConsentBanner /> : null}
    </ConsentContext.Provider>
  );
}

function CookieConsentBanner() {
  const { accept, decline } = useCookieConsent();

  return (
    // Not a modal: it must not trap focus or block the page, and a visitor who
    // ignores it is simply never tracked. role="region" + aria-label puts it in
    // the landmark list so screen-reader users can reach it deliberately.
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[90] px-3 pb-3 sm:px-4 sm:pb-4"
    >
      <div className="mx-auto max-w-3xl rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.12)] sm:p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base font-normal text-[color:var(--color-brand-navy)]">
          Cookies on our website
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
          We&apos;d like to use cookies to measure how our website and
          advertising perform. These are used on our public pages only —{" "}
          <strong className="font-semibold text-[color:var(--color-brand-navy)]">
            never in the Patient Portal
          </strong>
          , and never with your laboratory results, medical records, or DRM-ID.
          Booking and registration work exactly the same either way.{" "}
          <Link
            href="/privacy"
            className="underline underline-offset-2 hover:text-[color:var(--color-brand-navy)]"
          >
            Read our privacy notice
          </Link>
          .
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={decline}
            className="order-2 rounded-full border border-[color:var(--color-warm-line-soft)] px-5 py-2.5 text-sm font-medium text-[color:var(--color-ink-mid)] outline-none transition-colors hover:bg-[color:var(--color-warm-bg)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2 sm:order-1"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="order-1 rounded-full bg-[color:var(--color-brand-navy)] px-5 py-2.5 text-sm font-semibold text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2 sm:order-2"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

// Footer entry point for changing a previously-made choice. Renders nothing
// until consent has been resolved, so it never appears alongside the banner on
// a first visit.
export function CookiePreferencesLink({ className }: { className?: string }) {
  const { choice, reopen } = useCookieConsent();
  if (choice === undefined || choice === null) return null;
  return (
    <button type="button" onClick={reopen} className={className}>
      Cookie preferences
    </button>
  );
}
