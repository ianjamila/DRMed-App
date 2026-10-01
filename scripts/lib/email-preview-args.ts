/**
 * Argument parsing for `scripts/email-preview.mts`. Pure (no env, no clients), so it
 * can be unit-tested. Runner flags owned by env-guard (`--prod`, `--yes`) are ignored.
 */
import { shiftISODate } from "../../src/lib/dates/manila";

export type EmailPreviewArgs =
  | { ok: true; email: "patient-sources"; kind: "week" | "month"; today: string | null }
  | { ok: false; errors: string[] };

/** sysexits EX_USAGE — a bad flag or value (nothing was read). */
export const EXIT_USAGE = 64;

export function parseEmailPreviewArgs(argv: readonly string[]): EmailPreviewArgs {
  const errors: string[] = [];
  const words: string[] = [];
  let kind: "week" | "month" = "week";
  let today: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "prod" || name === "yes") continue;
    if (name === "month") {
      kind = "month";
      continue;
    }
    if (name === "today") {
      const value = eq !== -1 ? arg.slice(eq + 1) : i + 1 < argv.length && !argv[i + 1]!.startsWith("--") ? argv[++i]! : undefined;
      if (value === undefined) errors.push("--today needs a value like 2026-10-05.");
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || shiftISODate(value, 0) !== value) errors.push(`--today must be a real date like 2026-10-05 (got “${value}”).`);
      else today = value;
      continue;
    }
    errors.push(`Unknown option --${name}.`);
  }

  if (words.length === 0) errors.push("Say which email: patient-sources.");
  else if (words[0] !== "patient-sources") errors.push(`Unknown email “${words[0]}” — the only one is patient-sources.`);
  else if (words.length > 1) errors.push(`Unexpected argument “${words[1]}”.`);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, email: "patient-sources", kind, today };
}

export function previewFileBase(kind: "week" | "month", fromISO: string): string {
  return `patient-sources-${kind}-${fromISO}`;
}
