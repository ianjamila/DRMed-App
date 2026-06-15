// Client-side compression for doctor's request-form photos. Optimized for
// LEGIBILITY (small printed + handwritten text reception must read), not for
// minimum bytes: downscale the long edge to <=2200px and re-encode JPEG q0.82.
// PDFs, HEIC/HEIF the browser can't decode, and already-small images pass
// through untouched. Runs in the browser ('use client' callers only).

const MAX_EDGE = 2200;
const JPEG_QUALITY = 0.82;
const SKIP_IF_UNDER_BYTES = 600 * 1024;

/** Pure: target dimensions preserving aspect ratio within `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

function canTryCanvas(file: File): boolean {
  // HEIC/HEIF only decode on Safari; PDFs never. Pass those through.
  return file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp";
}

/**
 * Returns a (possibly) compressed File. Never throws — on any failure it
 * resolves to the original file so a booking is never blocked by compression.
 */
export async function compressImage(file: File): Promise<File> {
  if (!canTryCanvas(file)) return file;
  if (file.size <= SKIP_IF_UNDER_BYTES) return file;

  try {
    // `imageOrientation: "from-image"` bakes EXIF rotation into the pixels so
    // a sideways phone photo doesn't reach reception rotated.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file; // don't upsize

    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
