"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LIMITS,
  EMPTY_SELECTION,
  addEntries,
  canAdd as canAddPure,
  keysByKind as keysByKindPure,
  recordsOf,
  removeKeys,
  toggleEntry,
  type SelectionEntry,
  type SelectionLimits,
  type SelectionState,
} from "@/lib/ui/bulk-selection";

export interface RowSelection {
  state: SelectionState;
  isSelected: (rowKey: string) => boolean;
  toggle: (entry: SelectionEntry) => void;
  /** Header select-all: adds (stopping at the caps) or removes the given entries. */
  setMany: (entries: readonly SelectionEntry[], selected: boolean) => void;
  clear: () => void;
  /** Prune after a successful action, or when a row's checkbox unmounts / changes kind. */
  clearKeys: (rowKeys: readonly string[]) => void;
  canAdd: (entry: SelectionEntry) => boolean;
  keysByKind: Record<string, string[]>;
  count: number;
  records: number;
  /** How many rows the last setMany could not add because a cap was reached; 0 after any other change. */
  refusedCount: number;
  limits: SelectionLimits;
}

const SelectionContext = createContext<RowSelection | null>(null);

interface ProviderProps {
  /**
   * A normalised string of every list parameter that changes the row set or
   * its order (view, filters, sort, page, size, search…). Search-param
   * navigation does NOT remount client components by itself, so the provider
   * watches this value and resets the selection itself whenever it changes
   * (see the render-time check in `SelectionProvider` below) — WITHOUT
   * remounting `children`. An earlier version applied `resetKey` as the React
   * `key` of an inner provider, which reset the selection by remounting the
   * whole subtree — but that subtree can hold OTHER client state that has
   * nothing to do with selection (e.g. the appointments page's "Bookings
   * with no set time" section nests `LikelyNoShowBar`, whose "Marked N as
   * no-show — Undo" banner lives in its own `useState`), and a remount wiped
   * that state too, every time a filter changed, even though the banner's
   * rows had nothing to do with the selection being reset.
   */
  resetKey: string;
  limits?: SelectionLimits;
  children: ReactNode;
}

interface SelectionAndRefused {
  selection: SelectionState;
  /** How many rows the last setMany could not add because a cap was reached; 0 after any other change. */
  refused: number;
  /** The `resetKey` this state belongs to — see the render-time reset check below. */
  key: string;
}

function emptyFor(key: string): SelectionAndRefused {
  return { selection: EMPTY_SELECTION, refused: 0, key };
}

export function SelectionProvider({ resetKey, limits, children }: ProviderProps) {
  const resolvedLimits = limits ?? DEFAULT_LIMITS;

  // Selection, refusedCount and the resetKey they belong to live in ONE state
  // object so every updater can return all three from a single, pure
  // function — React (StrictMode especially) requires a setState updater to
  // have no side effects, and calling a second setState from inside one is
  // exactly that.
  const [sel, setSel] = useState<SelectionAndRefused>(() => emptyFor(resetKey));

  // React's documented "adjust state while rendering when a prop changes"
  // pattern (https://react.dev/learn/you-might-not-need-an-effect): compare
  // the prop to what's stored in state DURING render, and if it changed,
  // call setState right here rather than from an effect. An effect would
  // still commit one render with the stale (pre-reset) selection before
  // firing; this stays in sync with `resetKey` on the very render that
  // changed it, with no wasted/incorrect commit and no remount of `children`.
  let current = sel;
  if (sel.key !== resetKey) {
    current = emptyFor(resetKey);
    setSel(current);
  }

  const toggle = useCallback(
    (entry: SelectionEntry) => {
      setSel((prev) => ({
        selection: toggleEntry(prev.selection, entry, resolvedLimits),
        refused: 0,
        key: prev.key,
      }));
    },
    [resolvedLimits],
  );

  const setMany = useCallback(
    (entries: readonly SelectionEntry[], selected: boolean) => {
      if (!selected) {
        setSel((prev) => ({
          selection: removeKeys(prev.selection, entries.map((e) => e.rowKey)),
          refused: 0,
          key: prev.key,
        }));
        return;
      }
      setSel((prev) => {
        const { next, refused } = addEntries(prev.selection, entries, resolvedLimits);
        return { selection: next, refused: refused.length, key: prev.key };
      });
    },
    [resolvedLimits],
  );

  const clear = useCallback(() => {
    setSel((prev) => emptyFor(prev.key));
  }, []);

  const clearKeys = useCallback((rowKeys: readonly string[]) => {
    if (rowKeys.length === 0) return;
    setSel((prev) => {
      // removeKeys returns the same reference when nothing was removed, so
      // returning prev unchanged (same object identity) lets React bail out
      // of the re-render — load-bearing for the unmount-pruning effect, which
      // fires for every row on a full revalidation.
      const next = removeKeys(prev.selection, rowKeys);
      if (next === prev.selection) return prev;
      return { selection: next, refused: 0, key: prev.key };
    });
  }, []);

  const isSelected = useCallback(
    (rowKey: string) => current.selection.has(rowKey),
    [current.selection],
  );
  const canAdd = useCallback(
    (entry: SelectionEntry) => canAddPure(current.selection, entry, resolvedLimits),
    [current.selection, resolvedLimits],
  );
  const byKind = useMemo(() => keysByKindPure(current.selection), [current.selection]);

  const value = useMemo<RowSelection>(
    () => ({
      state: current.selection,
      isSelected,
      toggle,
      setMany,
      clear,
      clearKeys,
      canAdd,
      keysByKind: byKind,
      count: current.selection.size,
      records: recordsOf(current.selection),
      refusedCount: current.refused,
      limits: resolvedLimits,
    }),
    [current, isSelected, toggle, setMany, clear, clearKeys, canAdd, byKind, resolvedLimits],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useRowSelection(): RowSelection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useRowSelection must be used within a SelectionProvider");
  return ctx;
}
