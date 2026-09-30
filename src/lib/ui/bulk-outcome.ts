// The text every bulk bar shows after an action: a head sentence, then EVERY
// row that was not changed — named, with why — and every row the bar never
// sent. The bar clears the selection afterwards, so this text is the only
// record of what was left alone: never cap or summarise it (Codex P2 on #245).

export interface OutcomeLine {
  label: string;
  reason: string;
}

export interface BulkOutcomeInput {
  /** Past tense, capitalised: "Claimed", "Cancelled", "Marked". */
  verb: string;
  /** Words after the noun: "arrived", "as no-show". */
  tail?: string;
  noun: { one: string; many: string };
  sent: number;
  changed: number;
  notChanged: readonly OutcomeLine[];
  /** Rows the bar left out before sending (e.g. an inactive patient for Mark arrived). */
  notSent?: readonly OutcomeLine[];
}

function counted(n: number, noun: { one: string; many: string }): string {
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

export function formatBulkOutcome(input: BulkOutcomeInput): string {
  const tail = input.tail ? ` ${input.tail}` : "";
  const head =
    input.changed === 0
      ? `Nothing ${input.verb.toLowerCase()}${tail}.`
      : input.changed === input.sent
        ? `${input.verb} ${counted(input.changed, input.noun)}${tail}.`
        : `${input.verb} ${input.changed} of ${counted(input.sent, input.noun)}${tail}.`;
  const lines = [head];
  const section = (title: string, rows: readonly OutcomeLine[] | undefined) => {
    if (!rows || rows.length === 0) return;
    lines.push(`${title} (${rows.length}):`, ...rows.map((r) => `• ${r.label}: ${r.reason}`));
  };
  section("Not changed", input.notChanged);
  section("Skipped", input.notSent);
  return lines.join("\n");
}
