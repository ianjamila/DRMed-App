"use client";

import { useRef } from "react";
import { Upload, X, FileText } from "lucide-react";
import { compressImage } from "@/lib/images/compress-image";
import type { IntakePreference } from "@/lib/appointments/lab-request";

const MAX_FILES = 5;
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

export function LabRequestUpload({
  files,
  onFilesChange,
  preference,
  onPreferenceChange,
  error,
}: {
  files: File[];
  onFilesChange: (next: File[]) => void;
  preference: IntakePreference | null;
  onPreferenceChange: (p: IntakePreference) => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (picked.length === 0) return;
    const room = MAX_FILES - files.length;
    const compressed = await Promise.all(picked.slice(0, room).map((f) => compressImage(f)));
    onFilesChange([...files, ...compressed]);
  }

  function removeAt(i: number) {
    onFilesChange(files.filter((_, idx) => idx !== i));
  }

  return (
    <div className="mt-5 rounded-[18px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] p-5">
      <h4 className="font-[family-name:var(--font-display)] text-[19px] text-[color:var(--color-brand-navy)]">
        Have a doctor&apos;s request form?
      </h4>
      <p className="mt-1 text-[13.5px] text-[color:var(--color-ink-mid)]">
        Skip the test list — upload a photo or PDF and we&apos;ll order exactly
        what your doctor requested. You can still tick tests below if you like.
      </p>

      {files.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-[12px] border border-[color:var(--color-warm-line)] bg-white px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
                <span className="truncate text-[color:var(--color-ink)]">{f.name}</span>
                <span className="shrink-0 text-xs text-[color:var(--color-ink-soft)]">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${f.name}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-soft)] transition hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-danger)]"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {files.length < MAX_FILES ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-full border-[1.5px] border-[color:var(--color-brand-navy)] bg-white px-5 py-2.5 text-sm font-bold text-[color:var(--color-brand-navy)] transition hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          <Upload className="h-4 w-4" />
          {files.length === 0 ? "Upload request form" : "Add another"}
        </button>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={handlePick}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      <p className="mt-2 text-xs text-[color:var(--color-ink-soft)]">
        Up to {MAX_FILES} photos/PDFs · 10 MB each · photos are optimized
        automatically.
      </p>

      {files.length > 0 ? (
        <fieldset className="mt-4">
          <legend className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
            How should we handle this?{" "}
            <span className="text-[color:var(--color-danger)]">*</span>
          </legend>
          <div className="mt-2 grid gap-2">
            {(
              [
                { value: "walk_in", label: "I'll just walk in — read my form at the counter" },
                { value: "callback", label: "Please confirm the tests and price with me first" },
              ] as const
            ).map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-2.5 rounded-[12px] border-[1.5px] bg-white p-3 text-sm transition ${
                  preference === opt.value
                    ? "border-[color:var(--color-brand-cyan)]"
                    : "border-[color:var(--color-warm-line)]"
                }`}
              >
                <input
                  type="radio"
                  name="lab_request_intake"
                  checked={preference === opt.value}
                  onChange={() => onPreferenceChange(opt.value)}
                  className="mt-0.5 h-5 w-5 accent-[color:var(--color-brand-cyan)]"
                />
                <span className="text-[color:var(--color-ink-mid)]">{opt.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p className="mt-2 text-[12.5px] text-[color:var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
