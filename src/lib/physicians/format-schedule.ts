import { DAY_NAMES, formatTime } from "./schedule";

interface Block {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

// Render a physician's recurring blocks as the human-readable schedule lines
// the marketing /physicians page expects, e.g.
//   ["Monday and Wednesday · 10:00 AM – 12:00 NN", "Saturday · 2:00 PM – 4:00 PM"]
//
// Blocks that share the same start/end window are joined into a single line
// with the days listed (using "and" for two, comma+oxford for 3+). A
// physician with no blocks gets a single "By appointment" line.
export function formatSchedule(blocks: Block[]): string[] {
  if (blocks.length === 0) return ["By appointment"];

  const groups = new Map<string, number[]>();
  for (const b of blocks) {
    const key = `${b.start_time}|${b.end_time}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.includes(b.day_of_week)) existing.push(b.day_of_week);
    } else {
      groups.set(key, [b.day_of_week]);
    }
  }

  const lines: string[] = [];
  for (const [key, dows] of groups) {
    const [start, end] = key.split("|");
    dows.sort((a, b) => a - b);
    const dayList = formatDayList(dows);
    lines.push(`${dayList} · ${formatTime(start!)} – ${formatTime(end!)}`);
  }
  return lines;
}

function formatDayList(dows: number[]): string {
  const names = dows.map((d) => DAY_NAMES[d]!);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
