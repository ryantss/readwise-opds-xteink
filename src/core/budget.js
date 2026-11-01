// Portrait page on the X3. The framebuffer is stored 792×528
// (FreeInkDisplay.h X3_DISPLAY_WIDTH/HEIGHT) and the reader holds it tall.
export const X3_SCREEN = { width: 528, height: 792 };

// Baseline grayscale. CrossInk's JPEGDEC path is the one the reader uses,
// and progressive scans are the ones it has to fall back from.
export const JPEG_QUALITY = 45;

// CrossInk v1.6.1 issue 836: wolfSSL returns MEMORY_E (-125) after 219615 of
// 893468 bytes when the largest free block is 13300. Vercel does not accept
// max_fragment_length, so records stay up to 16KB. Finish before that prefix.
export const X3_COMPLETE_READ_BYTES = 219_615;
export const TLS_RECORD_BYTES = 16 * 1024;
export const EPUB_BYTE_BUDGET = 160 * 1024;

export function x3DownloadOutcome(byteLength) {
  if (byteLength <= X3_COMPLETE_READ_BYTES) {
    return { ok: true, received: byteLength, total: byteLength };
  }
  const received = Math.floor(X3_COMPLETE_READ_BYTES / TLS_RECORD_BYTES) * TLS_RECORD_BYTES;
  return { ok: false, received, total: byteLength, error: "MEMORY_E" };
}

// Keep cover, then inline images in document order, skipping any one image
// that would push the measured EPUB past the budget. Text is not in this list.
export function selectAssets({ cover = null, images, measure, budget = EPUB_BYTE_BUDGET }) {
  let chosenCover = null;
  if (cover && measure({ cover, images: [] }) <= budget) chosenCover = cover;

  const chosen = [];
  for (const image of images) {
    if (measure({ cover: chosenCover, images: [...chosen, image] }) <= budget) chosen.push(image);
  }
  return { cover: chosenCover, images: chosen };
}
