"use client";
import { useActionState } from "react";
import type { CandidatePair } from "@/lib/patients/find-duplicates";
import type { DupSignal } from "@/lib/patients/duplicates";
import { mergeCandidateAction, undoMergeAction, type MergeResult, type UndoResult, type RecentMerge } from "../actions";

const SIGNAL_LABEL: Record<DupSignal, string> = {
  exact_email: "Same email",
  same_birthdate: "Same birthdate",
  same_last_name: "Same surname",
  same_first_name: "Same first name",
  fuzzy_name: "Similar name",
  same_phone: "Same phone",
  same_address: "Same address",
  same_sex: "Same sex",
};

const TIER_STYLE: Record<string, string> = {
  exact_dup: "bg-red-100 text-red-800",
  strong: "bg-orange-100 text-orange-800",
  probable: "bg-amber-100 text-amber-800",
  weak: "bg-slate-100 text-slate-600",
};

function MergeButton({ pair }: { pair: CandidatePair }) {
  const [state, action, pending] = useActionState<MergeResult | null, FormData>(mergeCandidateAction, null);
  // keep = older record; source = newer.
  const older = pair.a.created_at <= pair.b.created_at ? pair.a : pair.b;
  const newer = older.id === pair.a.id ? pair.b : pair.a;
  if (state?.ok) return <span className="text-sm font-semibold text-green-700">Merged ✓</span>;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Merge ${newer.drm_id} into ${older.drm_id}? This can be undone within 30 days.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="keep_id" value={older.id} />
      <input type="hidden" name="source_id" value={newer.id} />
      <button disabled={pending} className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? "Merging…" : `Merge into ${older.drm_id}`}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function UndoButton({ merge }: { merge: RecentMerge }) {
  const [state, action, pending] = useActionState<UndoResult | null, FormData>(undoMergeAction, null);
  if (state?.ok) return <span className="text-xs text-green-700">Undone ✓</span>;
  return (
    <form action={action} onSubmit={(e) => { if (!confirm("Undo this merge?")) e.preventDefault(); }}>
      <input type="hidden" name="merge_id" value={merge.id} />
      <button disabled={pending} className="text-xs font-semibold text-cyan-700 hover:underline disabled:opacity-50">
        {pending ? "Undoing…" : "Undo"}
      </button>
      {state && !state.ok && <span className="ml-2 text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

function Person({ p }: { p: CandidatePair["a"] }) {
  return (
    <div className="text-sm">
      <div className="font-semibold">{p.first_name} {p.last_name} <span className="text-slate-400">· {p.drm_id}</span> {p.is_legacy && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">legacy</span>}</div>
      <div className="text-slate-500">{p.birthdate ?? "—"} · {p.email ?? "no email"} · {p.phone_normalized ?? "no phone"}</div>
    </div>
  );
}

export function CandidatesClient({ pairs, recent }: { pairs: CandidatePair[]; recent: RecentMerge[] }) {
  return (
    <div className="space-y-6">
      {pairs.length === 0 ? (
        <p className="text-sm text-slate-500">No candidate pairs at this confidence level. 🎉</p>
      ) : (
        <ul className="space-y-3">
          {pairs.map((pair) => (
            <li key={`${pair.id_a}:${pair.id_b}`} className="rounded-lg border p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${TIER_STYLE[pair.score.tier ?? "weak"]}`}>{pair.score.tier}</span>
                <div className="flex flex-wrap gap-1">
                  {pair.score.signals.map((s) => (
                    <span key={s} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{SIGNAL_LABEL[s]}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <Person p={pair.a} />
                  <Person p={pair.b} />
                </div>
                <MergeButton pair={pair} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-bold">Recently merged (undo within 30 days)</h2>
          <ul className="divide-y">
            {recent.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                <span>{m.source_drm_id} → {m.keep_drm_id} <span className="text-slate-400">· {new Date(m.merged_at).toLocaleDateString("en-PH")}</span></span>
                <UndoButton merge={m} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
