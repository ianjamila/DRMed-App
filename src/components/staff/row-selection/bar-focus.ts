"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

// Keyboard jump between a list's checkboxes and its selection bar (bulk-select
// follow-ups item 7). Decoupled through a DOM event so the kit bar and the
// visit page's own bar (a separate selection context) share one mechanism:
// checkboxes call requestBarFocus() on Enter, and whichever bar is mounted
// listens for it and for Alt+B.

export const BAR_FOCUS_EVENT = "staff:focus-selection-bar";

/** First-choice targets inside the bar: enabled action controls, in DOM order. */
export const FOCUSABLE_IN_BAR =
  "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";

/**
 * Same controls, scoped to a bar's actions container (`[data-bar-actions]` —
 * the kit BulkBar's and the visit page's own bar's `ml-auto flex …` div).
 * Querying this first is what keeps the keyboard jump off "Clear" (which
 * lives in the count line, ahead of the actions container) and off an inline
 * outcome panel's Undo/Dismiss (excluded separately — see
 * firstBarFocusTarget — because BulkOutcomePanel can render as the actions
 * container's first child while rows stay selected).
 */
export const ACTIONS_FIRST_SELECTOR = FOCUSABLE_IN_BAR.split(",")
  .map((selector) => `[data-bar-actions] ${selector.trim()}`)
  .join(", ");

export function isBarShortcut(e: {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.code === "KeyB" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

export function isTextTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
}

/** Called by a selection checkbox on Enter. */
export function requestBarFocus(): void {
  document.dispatchEvent(new CustomEvent(BAR_FOCUS_EVENT));
}

/**
 * Where the keyboard jump (Alt+B / Enter-on-checkbox) sends focus inside a
 * mounted bar: the first enabled ACTION control — inside `[data-bar-actions]`
 * and not part of an inline outcome panel (`[data-bar-outcome]`, which can
 * render as that container's first child while rows stay selected) — falling
 * back to any enabled control anywhere in the bar, then the bar itself.
 */
export function firstBarFocusTarget(bar: HTMLElement): HTMLElement {
  const actionCandidates = bar.querySelectorAll<HTMLElement>(ACTIONS_FIRST_SELECTOR);
  for (const el of actionCandidates) {
    if (!el.closest("[data-bar-outcome]")) return el;
  }
  return bar.querySelector<HTMLElement>(FOCUSABLE_IN_BAR) ?? bar;
}

/**
 * Wires a mounted bar: Alt+B and BAR_FOCUS_EVENT move focus into `barRef`;
 * the element focused before the jump is remembered, and restoreFocus() puts
 * focus back there (call it before the bar closes). Returns restoreFocus.
 */
export function useBarFocus(barRef: RefObject<HTMLElement | null>, active: boolean): () => void {
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const jump = () => {
      const bar = barRef.current;
      if (!bar) return;
      const current = document.activeElement;
      if (current instanceof HTMLElement && !bar.contains(current)) returnTo.current = current;
      const target = firstBarFocusTarget(bar);
      target.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isBarShortcut(e) || isTextTarget(e.target)) return;
      e.preventDefault();
      jump();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener(BAR_FOCUS_EVENT, jump);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener(BAR_FOCUS_EVENT, jump);
    };
  }, [active, barRef]);

  // Stable identity: callers list it in effect / useCallback deps.
  return useCallback(() => {
    const bar = barRef.current;
    const el = returnTo.current;
    returnTo.current = null;
    if (!bar || !bar.contains(document.activeElement)) return;
    if (el && el.isConnected) el.focus();
  }, [barRef]);
}
