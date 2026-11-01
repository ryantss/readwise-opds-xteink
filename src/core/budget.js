// Portrait page on the X3. The framebuffer is stored 792×528
// (FreeInkDisplay.h X3_DISPLAY_WIDTH/HEIGHT) and the reader holds it tall.
export const X3_SCREEN = { width: 528, height: 792 };

export const JPEG_QUALITY = 45;

// 1 Nov video, "The Rise of the Self-Driving Company". Production sent
// Content-Length 502491. The bar stopped on the last 64KiB progress tick,
// 7 * 65536 = 458752 (91%). This host harness finishes a full body of that
// length with keep-alive, with a TLS close_notify, and with a TCP RST after
// the last byte. Cutting the stream at 458752 while still advertising 502491
// makes wolfSSL return SOCKET_PEER_CLOSED_E (-397) and HttpDownloader log
// "Incomplete: got 458752 of 502491" before sync, ZipFile, or .part publish.
//
// v1.6.1 OpdsBookBrowserActivity::downloadBook (OpdsBookBrowserActivity.cpp:682)
// never calls clearEntries(), so the parsed catalog stays allocated during the
// EPUB GET. A later note on CrossInk issue 836 says freeing that catalog before
// the GET let the same book finish.
//
// EPUB_BYTE_BUDGET only shortens the TLS read. It is a size workaround, not a
// proven fix for that allocation. Text-only articles are not capped. A
// 435317-byte text EPUB still ships whole.
export const OBSERVED_BODY_BYTES = 502_491;
export const OBSERVED_TAIL_STOP = 7 * 64 * 1024;
export const UNCAPPED_TEXT_EXAMPLE_BYTES = 435_317;
export const EPUB_BYTE_BUDGET = 160 * 1024;

export function x3DownloadOutcome(byteLength, received = byteLength) {
  if (received === byteLength) return { ok: true, received, total: byteLength };
  return { ok: false, received, total: byteLength, error: "SOCKET_PEER_CLOSED_E" };
}

export function selectAssets({ cover = null, images, measure, budget = EPUB_BYTE_BUDGET }) {
  let chosenCover = null;
  if (cover && measure({ cover, images: [] }) <= budget) chosenCover = cover;

  const chosen = [];
  for (const image of images) {
    if (measure({ cover: chosenCover, images: [...chosen, image] }) <= budget) chosen.push(image);
  }
  return { cover: chosenCover, images: chosen };
}
