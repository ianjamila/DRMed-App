"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  getPackagePdfDownloadUrl,
  getPatientResultDownloadUrl,
} from "./actions";

// Per-component status surface for the "Show individual results" panel.
// `released` shows a download link, `cancelled` is rendered greyed out
// (the patient should still see it was on the order), and anything else
// renders as in-progress.
export interface PackageComponentRow {
  id: string;
  status: string;
  test_name: string;
  test_code: string;
  has_result: boolean;
}

export interface PackageCardProps {
  header: {
    id: string;
    visit_id: string;
    visit_number: string;
    visit_date: string;
    package_name: string;
    package_code: string;
    released_at: string | null;
  };
  components: PackageComponentRow[];
  releasedCount: number;
  totalCount: number; // excludes cancelled
  consolidatedAvailable: boolean;
}

// Patient-facing card for a package result. Shows a single
// "Download package result" CTA that pulls the consolidated PDF (cover
// + every released component PDF concatenated) and an expandable list
// of components with per-component download links.
export function PackageCard(props: PackageCardProps) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function downloadConsolidated() {
    setError(null);
    start(async () => {
      const result = await getPackagePdfDownloadUrl(props.header.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // base64 → Blob → object URL → click → revoke. The transient
      // anchor is appended to the document so iOS Safari triggers the
      // download instead of navigating.
      const bytes = Uint8Array.from(atob(result.pdfBase64), (c) =>
        c.charCodeAt(0),
      );
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  async function downloadComponent(componentId: string) {
    setError(null);
    const result = await getPatientResultDownloadUrl(componentId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  return (
    <article className="mb-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            {props.header.package_name}
          </h2>
          <p className="mt-0.5 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
            {props.header.package_code} · Visit #{props.header.visit_number} ·{" "}
            {new Date(props.header.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-mid)]">
            {props.releasedCount} of {props.totalCount} components released
            {props.header.released_at ? (
              <>
                {" · released "}
                {new Date(props.header.released_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={downloadConsolidated}
          disabled={!props.consolidatedAvailable || pending}
          className="min-h-[44px] bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)] disabled:bg-[color:var(--color-brand-bg-mid)]"
          title={
            !props.consolidatedAvailable
              ? "Available when all components are released"
              : undefined
          }
        >
          {pending ? "Preparing…" : "Download package result"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setExpanded((p) => !p)}
          className="min-h-[44px]"
        >
          {expanded ? "Hide individual results" : "Show individual results"}
        </Button>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] border-t border-[color:var(--color-brand-bg-mid)] pt-3">
          {props.components.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="font-semibold text-[color:var(--color-brand-navy)]">
                  {c.test_name}
                </p>
                <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {c.test_code}
                </p>
              </div>
              {c.status === "released" && c.has_result ? (
                <button
                  type="button"
                  onClick={() => downloadComponent(c.id)}
                  className="min-h-[44px] text-sm font-bold text-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-navy)] hover:underline"
                >
                  Download
                </button>
              ) : c.status === "cancelled" ? (
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Cancelled
                </span>
              ) : c.status === "released" ? (
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  No file
                </span>
              ) : (
                <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                  In progress
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
