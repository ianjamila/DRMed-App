"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  // Aria label for the drawer container; used by the close button + region.
  label: string;
  children: React.ReactNode;
}

// Slide-in left drawer used by the marketing and staff mobile navs.
// Body scroll locks while open. ESC closes. Click on the backdrop closes.
// Rendered through a portal so the drawer is not constrained by ancestor
// stacking contexts (sticky headers in particular).
export function MobileDrawer({
  open,
  onClose,
  label,
  children,
}: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[60] md:hidden"
    >
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <div className="relative flex h-full w-[85%] max-w-sm flex-col overflow-y-auto bg-white shadow-2xl">
        {children}
      </div>
    </div>,
    document.body,
  );
}

// A small hamburger icon used by the triggers. Same size + stroke as
// NotificationBell so the two sit consistently in the topbar.
export function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
