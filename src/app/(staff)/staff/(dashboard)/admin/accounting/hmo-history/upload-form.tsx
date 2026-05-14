"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { todayManilaISODate } from "@/lib/dates/manila";

import { parseWorkbookAction } from "./actions";

export function UploadForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cutover, setCutover] = useState(todayManilaISODate());

  return (
    <form
      className="rounded-lg border p-5 space-y-4 bg-card"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const formData = new FormData(e.currentTarget);
        startTransition(async () => {
          const res = await parseWorkbookAction(formData);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.push(`/staff/admin/accounting/hmo-history/${res.data.run_id}`);
        });
      }}
    >
      <div>
        <label className="block text-sm font-medium mb-2" htmlFor="file">
          Workbook (XLSX or per-tab CSV)
        </label>
        <input
          id="file"
          type="file"
          name="file"
          accept=".xlsx,.csv"
          required
          disabled={isPending}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-primary-foreground file:font-medium min-h-[44px]"
        />
      </div>

      <div>
        <label htmlFor="cutover" className="block text-sm font-medium mb-2">
          Cutover date (Manila timezone)
        </label>
        <input
          id="cutover"
          type="date"
          name="cutover_date"
          value={cutover}
          onChange={(e) => setCutover(e.target.value)}
          max={todayManilaISODate()}
          required
          disabled={isPending}
          className="block rounded-md border px-3 py-2 text-sm min-h-[44px]"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Rows dated on or before this date will import as historical. After commit,
          NEW HMO claims must be entered through the operational UI, not the workbook.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 min-h-[44px]"
      >
        {isPending ? "Uploading and parsing…" : "Upload and parse"}
      </button>
    </form>
  );
}
