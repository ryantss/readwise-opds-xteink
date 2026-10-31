import assert from "node:assert/strict";
import test from "node:test";

import {
  CROSSINK_MAX_PAGE_HREF_CHARS,
  decodePageToken,
  encodePageToken,
  FEED_PAGE_SIZE,
  listShelfPage,
  pageHref
} from "../src/core/paging.js";

test("FEED_PAGE_SIZE is 10", () => {
  assert.equal(FEED_PAGE_SIZE, 10);
});

test("page tokens encode the page number and optional Readwise cursor", () => {
  assert.equal(encodePageToken(1, "rw1"), null);
  assert.equal(encodePageToken(2, "rw1"), "p2.cncx");
  assert.deepEqual(decodePageToken(null), { page: 1, readwiseCursor: null });
  assert.deepEqual(decodePageToken("p2.cncx"), { page: 2, readwiseCursor: "rw1" });
  assert.deepEqual(decodePageToken("p4"), { page: 4, readwiseCursor: null });
  assert.deepEqual(decodePageToken("legacy-cursor"), { page: 2, readwiseCursor: "legacy-cursor", legacy: true });
});

test("a deep page href stays under CrossInk MAX_PAGE_URL_CHARS", () => {
  const token = encodePageToken(9999, "x".repeat(200));
  const href = pageHref("https://rwopds.vercel.app", "/opds/shortlist", token);
  assert.ok(href.length < CROSSINK_MAX_PAGE_HREF_CHARS, href.length);
  assert.match(href, /cursor=p9999\./);
});

test("listShelfPage replays from the start when the token has no Readwise cursor", async () => {
  const calls = [];
  const pages = {
    "": { docs: [{ id: "a" }], nextCursor: "rw1" },
    rw1: { docs: [{ id: "b" }], nextCursor: "rw2" },
    rw2: { docs: [{ id: "c" }], nextCursor: null }
  };
  const listLocation = async ({ location, cursor, limit }) => {
    calls.push({ location, cursor, limit });
    return pages[cursor ?? ""] ?? { docs: [], nextCursor: null };
  };

  const direct = await listShelfPage(listLocation, { location: "new", page: 3, readwiseCursor: "rw2" });
  assert.deepEqual(
    calls.map((call) => call.cursor),
    ["rw2"]
  );
  assert.equal(direct.docs[0].id, "c");
  assert.equal(direct.previousReadwiseCursor, null);

  calls.length = 0;
  const replayed = await listShelfPage(listLocation, { location: "new", page: 3, readwiseCursor: null });
  assert.deepEqual(
    calls.map((call) => call.cursor),
    [null, "rw1", "rw2"]
  );
  assert.equal(replayed.docs[0].id, "c");
  assert.equal(replayed.previousReadwiseCursor, "rw2");
});
