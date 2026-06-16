"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  getPatientLabRequestFormUrl,
  deletePatientLabRequestUpload,
} from "./actions";

export interface UploadRow {
  id: string;
  filename: string;
  isPdf: boolean;
  thumbUrl: string | null;
  contextLabel: string | null;
  createdAt: string;
}

export function LabRequestUploads({ rows }: { rows: UploadRow[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  function openFile(id: string) {
    start(async () => {
      setError(null);
      setPendingId(id);
      const r = await getPatientLabRequestFormUrl(id);
      setPendingId(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.open(r.url, "_blank", "noopener,noreferrer");
    });
  }

  function removeFile(id: string) {
    if (!window.confirm("Remove this uploaded form? This can't be undone.")) return;
    start(async () => {
      setError(null);
      setPendingId(id);
      const r = await deletePatientLabRequestUpload(id);
      setPendingId(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <ul className="mt-3 space-y-3">
        {rows.map((row) => {
          const busy = pendingId === row.id;
          return (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3"
            >
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color:var(--color-brand-bg)]">
                {row.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-2xl" aria-hidden="true">
                    {row.isPdf ? "📄" : "🖼️"}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                  {row.contextLabel ?? "Doctor's request form"}
                </p>
                <p className="truncate text-xs text-[color:var(--color-brand-text-soft)]">
                  {row.filename} · uploaded{" "}
                  {new Date(row.createdAt).toLocaleDateString("en-PH", {
                    timeZone: "Asia/Manila",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  className="min-h-[44px] bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
                  onClick={() => openFile(row.id)}
                >
                  {busy ? "Opening…" : "View"}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-[44px] rounded-md px-2 text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                  onClick={() => removeFile(row.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
