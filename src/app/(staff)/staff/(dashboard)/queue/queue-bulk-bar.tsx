"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  parsePanelRowKey,
  rowTestCount,
  sentTestCount,
  type BulkQueueResult,
  type QueueRowInfo,
} from "@/lib/queue/bulk-queue";
import {
  claimQueueSelectionAction,
  deleteQueueSelectionAction,
  unclaimQueueSelectionAction,
} from "./panel-actions";

interface Props {
  // Every selectable row the page rendered: single tests keyed by test id,
  // chemistry panels by panelRowKey(visit, report group). A panel is acted on
  // WHOLE — the server resolves its full membership (panel-actions.ts).
  rowsByKey: Record<string, QueueRowInfo>;
}

type Panel = null | "unclaim" | "delete";

// Selected keys → single test ids and chemistry panels (panelRowKey).
function splitKeys(keys: readonly string[]) {
  const singleIds: string[] = [];
  const panels: Array<{ key: string; visitId: string; groupId: string }> = [];
  for (const key of keys) {
    const panel = parsePanelRowKey(key);
    if (panel) panels.push({ key, ...panel });
    else singleIds.push(key);
  }
  return { singleIds, panels };
}

// The lab queue's selection bar: Claim · Unclaim (optional reason) · Delete
// (required reason, red confirm — QueueDeleteDialog's wording). Each button
// acts on the selected rows that carry its kind; the server re-proves every
// row and reports the ones it skipped by name.
export function QueueBulkBar({ rowsByKey }: Props) {
  const { keysByKind, clearKeys, count } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Which button started the transition in flight — one useTransition serves
  // all three, so without this every visible button would read "…ing".
  const [running, setRunning] = useState<"claim" | "unclaim" | "delete" | null>(null);
  // The last action's outcome, naming every skipped test. It outlives the
  // selection it reports on (which is cleared on success), so it is kept here
  // and shown in place of the bar until dismissed or a new selection starts.
  const [outcome, setOutcome] = useState<string | null>(null);

  const known = (keys: string[] | undefined) =>
    (keys ?? []).filter((key) => rowsByKey[key] !== undefined);
  const claimKeys = known(keysByKind[QUEUE_KIND.claim]);
  // A single test sends the holder the operator saw, so it needs one. A
  // panel sends each bench member's holder as seen (it may be split between
  // holders — an admin recovering it), and the server compares them all.
  const unclaimKeys = known(keysByKind[QUEUE_KIND.unclaim]).filter(
    (key) => parsePanelRowKey(key) !== null || rowsByKey[key]!.assignedTo !== null,
  );
  const deleteKeys = known(keysByKind[QUEUE_KIND.delete]);

  function closePanel() {
    setPanel(null);
    setReason("");
    setErr(null);
  }

  function done(verb: string, keys: string[], result: BulkQueueResult, inPanel: boolean) {
    if (!result.ok) {
      // Nothing was attempted (role / input / reason) — keep the selection.
      if (inPanel) setErr(result.error);
      else alert(result.error);
      return;
    }
    // Counted in TESTS: a panel row stands for several (sentTestCount) — its
    // bench members for Claim / Unclaim, all of them for Delete.
    const scope = verb === "Deleted" ? "all" : "bench";
    setOutcome(bulkQueueMessage(verb, sentTestCount(result, rowsByKey, scope), result, rowsByKey));
    // Pruning wins (spec §4): clear everything sent; the outcome panel is the record.
    clearKeys(keys);
    closePanel();
    router.refresh();
  }

  function claim() {
    if (pending || claimKeys.length === 0) return;
    const keys = claimKeys;
    const { singleIds, panels } = splitKeys(keys);
    setRunning("claim");
    start(async () =>
      done(
        "Claimed",
        keys,
        // One call, so the server checks the record budget with every panel
        // counted in full before claiming anything.
        await claimQueueSelectionAction({
          testRequestIds: singleIds,
          panels: panels.map(({ visitId, groupId }) => ({ visitId, groupId })),
        }),
        false,
      ),
    );
  }

  function unclaim() {
    if (pending || unclaimKeys.length === 0) return;
    const keys = unclaimKeys;
    const { singleIds, panels } = splitKeys(keys);
    const items = singleIds.map((key) => ({
      testRequestId: key,
      assignedTo: rowsByKey[key]!.assignedTo!,
    }));
    const heldPanels = panels.map((p) => ({
      ...p,
      members: rowsByKey[p.key]!.bench ?? [],
    }));
    setRunning("unclaim");
    start(async () =>
      done(
        "Unclaimed",
        keys,
        await unclaimQueueSelectionAction({
          items,
          panels: heldPanels.map(({ visitId, groupId, members }) => ({ visitId, groupId, members })),
          reason: reason.trim() || undefined,
        }),
        true,
      ),
    );
  }

  function remove() {
    if (pending || deleteKeys.length === 0) return;
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    const keys = deleteKeys;
    setRunning("delete");
    start(async () =>
      done(
        "Deleted",
        keys,
        await deleteQueueSelectionAction({
          testRequestIds: splitKeys(keys).singleIds,
          panels: splitKeys(keys).panels.map(({ visitId, groupId }) => ({ visitId, groupId })),
          reason: reason.trim(),
        }),
        true,
      ),
    );
  }

  // In TESTS, not rows: a chemistry panel row stands for all its members.
  const testsIn = (keys: string[], scope: "bench" | "all") =>
    keys.reduce((n, key) => n + rowTestCount(rowsByKey[key], scope), 0);
  const panelCount =
    panel === "unclaim"
      ? testsIn(unclaimKeys, "bench")
      : panel === "delete"
        ? testsIn(deleteKeys, "all")
        : 0;
  // The rows behind an open panel can vanish under it (a realtime refresh
  // prunes them). Close it then, so it never reopens by itself — with the old
  // reason — over a later, unrelated selection. Render-time adjustment, the
  // same pattern SelectionProvider uses for resetKey.
  // A new selection replaces the last outcome; it never comes back later.
  if (count > 0 && outcome !== null) setOutcome(null);
  if (panel !== null && panelCount === 0) {
    setPanel(null);
    setReason("");
    setErr(null);
  }
  const n = (count: number) => `${count} test${count === 1 ? "" : "s"}`;

  if (count === 0) {
    if (!outcome) return null;
    // Same fixed slot the bar uses (see bulk-bar.tsx for why not sticky);
    // z-30 keeps it under any dialog/sheet overlay.
    return (
      <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-3 md:left-64 print:hidden">
        <div className="mx-auto w-full max-w-screen-2xl">
          <Panel role="status" className="flex items-start gap-3 p-3 text-xs shadow-lg">
            <p className="max-h-48 flex-1 overflow-y-auto whitespace-pre-line text-[color:var(--color-brand-text-mid)]">
              {outcome}
            </p>
            <button
              type="button"
              onClick={() => setOutcome(null)}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 font-semibold"
            >
              Dismiss
            </button>
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <BulkBar noun="test">
      {claimKeys.length > 0 ? (
        <Button type="button" size="sm" variant="brand" disabled={pending} onClick={claim}>
          {pending && running === "claim" ? "Claiming…" : `Claim (${testsIn(claimKeys, "bench")})`}
        </Button>
      ) : null}
      {unclaimKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-expanded={panel === "unclaim"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "unclaim" ? null : "unclaim");
          }}
        >
          Unclaim ({testsIn(unclaimKeys, "bench")})
        </Button>
      ) : null}
      {deleteKeys.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          aria-expanded={panel === "delete"}
          onClick={() => {
            setErr(null);
            setPanel(panel === "delete" ? null : "delete");
          }}
        >
          Delete ({testsIn(deleteKeys, "all")})
        </Button>
      ) : null}
      {panel !== null && panelCount > 0 ? (
        <div className="basis-full space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
          <p className="text-[color:var(--color-brand-text-mid)]">
            {panel === "unclaim" ? (
              <>
                Put {n(panelCount)} back in the queue for anyone in the section to claim.
                Only possible while no result has been uploaded.
              </>
            ) : (
              <>
                Remove {n(panelCount)} from the queue. Nothing is billed for a deleted
                entry, each can be restored later, and the reason is audit-logged.
              </>
            )}
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closePanel();
            }}
            maxLength={500}
            placeholder={panel === "unclaim" ? "Reason (optional)…" : "Reason (required)…"}
            aria-label={panel === "unclaim" ? "Reason for unclaiming" : "Reason for deleting"}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          {err ? (
            <p role="alert" className="text-red-600">
              {err}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={panel === "unclaim" ? unclaim : remove}
              disabled={pending}
              className={`min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50 ${
                panel === "delete" ? "bg-red-700" : "bg-[color:var(--color-brand-navy)]"
              }`}
            >
              {pending && running === panel
                ? panel === "delete"
                  ? "Deleting…"
                  : "Unclaiming…"
                : panel === "delete"
                  ? `Confirm delete (${panelCount})`
                  : `Confirm unclaim (${panelCount})`}
            </button>
            <button
              type="button"
              onClick={closePanel}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </BulkBar>
  );
}
