// Shelf pages are numbered in the public URL so rel="previous" stays short.
// Readwise only walks forward, so page N without a stored Readwise cursor is
// rebuilt by replaying pages 1..N. Direct next-hops carry the Readwise cursor
// as p{N}.{base64url(cursor)} and need one list call.
export const FEED_PAGE_SIZE = 10;
export const CROSSINK_MAX_PAGE_HREF_CHARS = 768;

const PAGE_TOKEN = /^p(\d+)(?:\.([A-Za-z0-9_-]+))?$/;

export function encodePageToken(page, readwiseCursor) {
  if (!page || page <= 1) return null;
  return readwiseCursor ? `p${page}.${base64urlEncode(readwiseCursor)}` : `p${page}`;
}

export function decodePageToken(token) {
  if (!token) return { page: 1, readwiseCursor: null };
  const match = PAGE_TOKEN.exec(token);
  if (!match) return { page: 2, readwiseCursor: token, legacy: true };
  return {
    page: Number(match[1]),
    readwiseCursor: match[2] ? base64urlDecode(match[2]) : null
  };
}

export function pageHref(baseUrl, path, token) {
  const href = token ? `${baseUrl}${path}?cursor=${encodeURIComponent(token)}` : `${baseUrl}${path}`;
  return href;
}

export async function listShelfPage(listLocation, { location, page, readwiseCursor, limit = FEED_PAGE_SIZE }) {
  const target = page < 1 ? 1 : page;
  if (target === 1) {
    const result = await listLocation({ location, cursor: null, limit });
    return { ...result, previousReadwiseCursor: null };
  }
  if (readwiseCursor) {
    const result = await listLocation({ location, cursor: readwiseCursor, limit });
    return { ...result, previousReadwiseCursor: null };
  }

  let cursor = null;
  let previousReadwiseCursor = null;
  let result = { docs: [], nextCursor: null };
  for (let n = 1; n <= target; n++) {
    result = await listLocation({ location, cursor, limit });
    previousReadwiseCursor = cursor;
    cursor = result.nextCursor;
    if (!cursor && n < target) return { docs: [], nextCursor: null, previousReadwiseCursor };
  }
  return { ...result, previousReadwiseCursor };
}

function base64urlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64urlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
