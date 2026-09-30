/**
 * Argument parsing for `scripts/first-night-check.ts`. Pure (no env, no
 * clients), so it can be unit-tested. Runner flags owned by env-guard
 * (`--prod`) are ignored here.
 */
import { CLI_MAX_DAYS, parseCheckParams, type CheckParams } from "../../src/lib/marketing/first-night-check";
import { shiftISODate } from "../../src/lib/dates/manila";

export type CliArgs = { ok: true; params: CheckParams; json: boolean } | { ok: false; errors: string[] };

const VALUE_FLAGS = new Set(["from", "to", "days", "threshold"]);
const BOOL_FLAGS = new Set(["json", "prod"]);

export function resolveCliArgs(argv: readonly string[], today: string): CliArgs {
  const errors: string[] = [];
  const values: Record<string, string> = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { errors.push(`Unexpected argument “${arg}”.`); continue; }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    if (BOOL_FLAGS.has(name)) { if (name === "json") json = true; continue; }
    if (!VALUE_FLAGS.has(name)) { errors.push(`Unknown option --${name}.`); continue; }
    if (eq !== -1) values[name] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) values[name] = argv[++i];
    else errors.push(`--${name} needs a value.`);
  }

  let from = values.from;
  if (values.days !== undefined) {
    if (values.from !== undefined) errors.push("Use either --days or --from, not both.");
    const n = /^\d+$/.test(values.days) ? Number(values.days) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > CLI_MAX_DAYS) {
      errors.push(`--days must be a whole number from 1 to ${CLI_MAX_DAYS}.`);
    } else {
      const to = values.to?.trim() || today;
      // A malformed --to is reported by parseCheckParams below.
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) from = shiftISODate(to, -(n - 1));
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const parsed = parseCheckParams({ from, to: values.to, threshold: values.threshold }, { maxDays: CLI_MAX_DAYS, today });
  return parsed.ok ? { ok: true, params: parsed.params, json } : { ok: false, errors: parsed.errors };
}
