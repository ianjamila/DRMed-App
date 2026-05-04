import { renderToBuffer } from "@react-pdf/renderer";
import { ResultDocument } from "./pdf-document";
import type { ResultDocumentInput } from "./types";

export async function renderResultPdf(
  input: ResultDocumentInput,
): Promise<Buffer> {
  // @react-pdf/renderer's React typings predate React 19. Cast through unknown
  // since we know the document is a valid <Document> tree at runtime.
  const doc = ResultDocument(input) as unknown as Parameters<
    typeof renderToBuffer
  >[0];
  return await renderToBuffer(doc);
}
