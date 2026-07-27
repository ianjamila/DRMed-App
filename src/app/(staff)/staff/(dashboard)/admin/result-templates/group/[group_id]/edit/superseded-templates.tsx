"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteSupersededTemplateAction } from "./actions";

export interface SupersededTemplate {
  templateId: string;
  serviceCode: string;
  serviceName: string;
  paramCount: number;
}

// The 0053 migration deactivated the per-service chemistry templates when the
// consolidated group template took over, but left the rows behind. They are
// unreachable — queue/[id] redirects any grouped service to the consolidated
// flow — yet the admin index used to file these services under "no template",
// inviting a pointless re-create. Surface + delete them here.
export function SupersededTemplates(props: {
  groupId: string;
  groupName: string;
  items: SupersededTemplate[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (props.items.length === 0) return null;

  function handleDelete(templateId: string) {
    setError(null);
    setBusyId(templateId);
    start(async () => {
      const res = await deleteSupersededTemplateAction({
        templateId,
        groupId: props.groupId,
      });
      setBusyId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
      <h3 className="font-heading text-lg font-extrabold text-amber-900">
        Superseded per-service templates ({props.items.length})
      </h3>
      <p className="mt-1 text-sm text-amber-900">
        These deactivated templates are unreachable: the queue always routes
        their services to the consolidated {props.groupName} form, so
        reactivating one does <strong>nothing</strong>. Safe to delete — the
        group template above is what medtechs actually use.
      </p>
      <ul className="mt-3 divide-y divide-amber-200">
        {props.items.map((t) => (
          <li
            key={t.templateId}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <p className="font-mono text-[10px] text-amber-800">
                {t.serviceCode}
              </p>
              <p className="truncate text-sm font-medium text-amber-900">
                {t.serviceName}{" "}
                <span className="font-normal">
                  · {t.paramCount} param{t.paramCount === 1 ? "" : "s"}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleDelete(t.templateId)}
              disabled={pending}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              {busyId === t.templateId ? "Deleting…" : "Delete"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
