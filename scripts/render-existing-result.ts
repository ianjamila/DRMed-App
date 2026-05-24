// Re-render an existing results row to disk using the current
// loadResultDocumentInput + renderResultPdf. Lets us verify renderer
// changes against a known DB row without going through the medtech UI.
//
// Usage:
//   set -a && . .env.local && set +a && tsx scripts/render-existing-result.ts <results.id> <out-path>

import { renderResultPdf } from "../src/lib/results/render-pdf";
import { loadResultDocumentInput } from "../src/lib/results/loaders";
import { writeFileSync } from "node:fs";

async function main() {
  const [, , resultId, outPath] = process.argv;
  if (!resultId || !outPath) {
    console.error("usage: tsx scripts/render-existing-result.ts <results.id> <out-path>");
    process.exit(1);
  }
  const input = await loadResultDocumentInput(resultId);
  const buf = await renderResultPdf(input);
  writeFileSync(outPath, buf);
  console.log(`wrote ${buf.length} bytes to ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
