// The 0179 redefinition of result_edit_commit is 0176's body plus exactly these
// text hunks — generated, never hand-copied, so the rest of the function
// cannot drift. result-copy-followups-migration.test.ts pins
// applyHunks(0176) === 0179. Pure: no server-only, no IO.

export interface Hunk {
  label: string;
  from: string;
  to: string;
}

const lines = (...l: string[]) => l.join("\n");

export const EDIT_COMMIT_0179_HUNKS: readonly Hunk[] = [
  {
    label: "a withdrawn alert is not a live match, so a value corrected back to it pages again",
    from: lines(
      "            and ca.observed_value_si is not distinct from d.observed_value_si",
      "       )",
      "      returning parameter_name, direction, observed_value_si, threshold_si",
    ),
    to: lines(
      "            and ca.observed_value_si is not distinct from d.observed_value_si",
      "            -- 0179: a withdrawn alert is history, not a live match — a value",
      "            -- corrected back to it pages again.",
      "            and ca.withdrawn_at is null",
      "       )",
      "      returning parameter_name, direction, observed_value_si, threshold_si",
    ),
  },
  {
    label: "removed alerts are withdrawn (kept as history), never deleted",
    from: lines(
      "    with gone as (",
      "      delete from public.critical_alerts ca",
      "       where ca.result_id = p_result_id",
      "         and ca.acknowledged_at is null",
    ),
    to: lines(
      "    -- 0179: a removed alert is WITHDRAWN (kept as history), never deleted.",
      "    with gone as (",
      "      update public.critical_alerts ca",
      "         set withdrawn_at = now(),",
      "             withdrawn_by = p_editor,",
      "             withdrawn_by_amendment = v_amend_id",
      "       where ca.result_id = p_result_id",
      "         and ca.acknowledged_at is null",
      "         and ca.withdrawn_at is null",
    ),
  },
  {
    label: "kept-acknowledged count ignores withdrawn rows",
    from: lines(
      "     where result_id = p_result_id",
      "       and acknowledged_at is not null;",
    ),
    to: lines(
      "     where result_id = p_result_id",
      "       and acknowledged_at is not null",
      "       and withdrawn_at is null; -- 0179",
    ),
  },
];

/** The `create or replace function public.<name>(` … `$$;` block, verbatim. */
export function extractFunction(sql: string, name: string): string {
  const head = `create or replace function public.${name}(`;
  const start = sql.indexOf(head);
  if (start < 0) throw new Error(`${name} not found`);
  const end = sql.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`${name} has no closing $$;`);
  return sql.slice(start, end + "\n$$;".length);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** Apply each hunk; every `from` must occur exactly once. */
export function applyHunks(body: string, hunks: readonly Hunk[]): string {
  let out = body;
  for (const h of hunks) {
    const n = count(out, h.from);
    if (n !== 1) throw new Error(`hunk "${h.label}" matched ${n} times (want 1)`);
    out = out.replace(h.from, h.to);
  }
  return out;
}
