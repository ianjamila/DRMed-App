"use client";

import { useState, useTransition } from "react";
import type { DashboardRole } from "@/lib/dashboards/cards";
import { setCardVisibility } from "./actions";
import { Panel } from "@/components/ui/panel";

interface CardItem {
  id: string;
  label: string;
  group: "snapshot" | "operations" | "money" | "people" | "attention";
  sensitive: boolean;
  visible: boolean;
}

const GROUP_LABEL: Record<CardItem["group"], string> = {
  snapshot: "Snapshot",
  operations: "Operations",
  money: "Money",
  people: "People",
  attention: "Activity strips",
};

export function DashboardCardSettingsClient({
  role,
  cards,
}: {
  role: DashboardRole;
  cards: CardItem[];
}) {
  // Local optimistic state so the toggle feels instant.
  const [localCards, setLocalCards] = useState(cards);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const grouped: Record<CardItem["group"], CardItem[]> = {
    snapshot: [],
    operations: [],
    money: [],
    people: [],
    attention: [],
  };
  for (const c of localCards) grouped[c.group].push(c);

  function toggle(cardId: string, currentlyVisible: boolean) {
    const nextVisible = !currentlyVisible;

    setLocalCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, visible: nextVisible } : c)),
    );
    setError(null);

    startTransition(async () => {
      const result = await setCardVisibility(role, cardId, nextVisible);
      if (!result.ok) {
        // Roll back optimistic update on failure.
        setLocalCards((prev) =>
          prev.map((c) =>
            c.id === cardId ? { ...c, visible: currentlyVisible } : c,
          ),
        );
        setError(result.error ?? "Failed to update card visibility.");
      }
    });
  }

  return (
    <>
      {error ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {localCards.length === 0 ? (
        <Panel className="p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No cards configured for this role.
        </Panel>
      ) : (
        <div className="space-y-6">
          {(Object.keys(grouped) as CardItem["group"][]).map((g) => {
            const items = grouped[g];
            if (items.length === 0) return null;
            return (
              <section
                key={g}
                className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white"
              >
                <h2 className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  {GROUP_LABEL[g]}
                </h2>
                <ul className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {items.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-[color:var(--color-brand-navy)]">
                            {c.label}
                          </p>
                          {c.sensitive ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                              Sensitive
                            </span>
                          ) : null}
                        </div>
                        <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                          {c.id}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggle(c.id, c.visible)}
                        disabled={pending}
                        aria-pressed={c.visible}
                        className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] disabled:cursor-wait disabled:opacity-60 ${
                          c.visible
                            ? "bg-[color:var(--color-brand-cyan)]"
                            : "bg-[color:var(--color-brand-bg-mid)]"
                        }`}
                      >
                        <span className="sr-only">
                          {c.visible ? "Hide card" : "Show card"}
                        </span>
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            c.visible ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
