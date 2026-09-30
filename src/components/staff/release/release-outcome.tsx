"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import type { SkippedRow } from "@/lib/queue/bulk-queue";

type Ctx = { show: (text: string) => void };
const ReleaseOutcomeContext = createContext<Ctx | null>(null);

function tests(n: number): string {
  return `test${n === 1 ? "" : "s"}`;
}

/**
 * Builds the one message for a release outcome. Takes counts (not id arrays)
 * so the queue and the visit page's actions share it.
 */
export function releaseOutcomeText(res: {
  changedCount: number;
  alsoReleasedCount: number;
  skipped: readonly SkippedRow[];
  warnings: readonly string[];
}): string | null {
  const lines: string[] = [];
  if (res.changedCount > 0) lines.push(`Released ${res.changedCount} ${tests(res.changedCount)}.`);
  if (res.alsoReleasedCount > 0) {
    lines.push(
      `Also released ${res.alsoReleasedCount} other ${tests(res.alsoReleasedCount)} on the same combined report.`,
    );
  }
  for (const s of res.skipped) lines.push(s.reason);
  lines.push(...res.warnings);
  return lines.length ? Array.from(new Set(lines)).join("\n") : null;
}

// A successful release refreshes the page, which unmounts whatever control
// held the message. This provider sits ABOVE the controls (router.refresh()
// does not remount it), so a partial-release warning or "patient was not
// notified" note survives the refresh.
export function ReleaseOutcomeProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const show = useCallback((t: string) => setText(t), []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ReleaseOutcomeContext.Provider value={value}>
      {text ? (
        <Panel role="status" className="mb-4 flex items-start gap-3 p-3 text-xs">
          <p className="flex-1 whitespace-pre-line text-[color:var(--color-brand-text-mid)]">{text}</p>
          <button
            type="button"
            onClick={() => setText(null)}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 font-semibold"
          >
            Dismiss
          </button>
        </Panel>
      ) : null}
      {children}
    </ReleaseOutcomeContext.Provider>
  );
}

/** Null outside a provider — the caller then shows the text inline. */
export function useReleaseOutcome(): Ctx | null {
  return useContext(ReleaseOutcomeContext);
}
