"use client";

import type { ReactNode } from "react";

export function ActionModal({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: "md" | "lg";
  children: ReactNode;
}) {
  if (!open) return null;
  const maxW = size === "lg" ? "max-w-2xl" : "max-w-md";
  const maxH = size === "lg" ? "max-h-[90vh] overflow-y-auto" : "";
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`w-full ${maxW} ${maxH} rounded-t-2xl bg-white p-6 md:rounded-2xl`}>
        <h2
          id="action-modal-title"
          className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]"
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">{description}</p>
        ) : null}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
