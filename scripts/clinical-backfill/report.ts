import { promises as fs } from "node:fs";
import path from "node:path";

function csvEscape(c: string): string { return `"${(c ?? "").replace(/"/g, '""')}"`; }

/** Write a CSV under tmp/ with a timestamped name; returns the path. */
export async function writeCsv(name: string, header: string[], rows: string[][]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name}-${ts}.csv`);
  const text = [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  await fs.writeFile(out, text);
  return out;
}
