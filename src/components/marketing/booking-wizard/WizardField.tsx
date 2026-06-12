"use client";

import { Check } from "lucide-react";

/**
 * Labeled input with inline validation (the bundle's `.field`): a red message +
 * shake when invalid, a green tick when satisfied. Controlled. `error` is the
 * zod message to show (empty/undefined = no error); `valid` lights the tick.
 */
export function WizardField({
  label,
  type = "text",
  value,
  onChange,
  required = false,
  placeholder,
  maxLength,
  inputMode,
  autoComplete,
  error,
  valid = false,
  id,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  inputMode?: "text" | "tel" | "email" | "numeric";
  autoComplete?: string;
  error?: string | null;
  valid?: boolean;
  id?: string;
}) {
  const fieldId = id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const isBad = Boolean(error);
  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
        {label}
        {required ? (
          <span className="text-[color:var(--color-danger)]"> *</span>
        ) : null}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          autoComplete={autoComplete}
          aria-invalid={isBad || undefined}
          className={`h-[46px] w-full rounded-[12px] border-[1.5px] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)] focus:shadow-[0_0_0_3px_rgba(8,168,226,0.20)] ${
            isBad
              ? "border-[color:var(--color-danger)] motion-safe:animate-[wizardshake_0.4s]"
              : "border-[color:var(--color-warm-line)]"
          }`}
        />
        {valid && !isBad ? (
          <Check
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#1B9E63]"
            strokeWidth={2.6}
          />
        ) : null}
      </div>
      {isBad ? (
        <p className="text-[12.5px] text-[color:var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
