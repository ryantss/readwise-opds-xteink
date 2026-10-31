import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkCrossInkHttpContract, probeUrl, runFixedServer, runLegacyServer } from "../scripts/crossink-http-probe.js";

test("vercel.json pins functions to Singapore", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.regions, ["sin1"]);
});

test("legacy production-like responses fail the CrossInk HTTP contract", async () => {
  const server = await runLegacyServer();
  try {
    const feed = await probeUrl(`${server.baseUrl}/opds`, { kind: "feed" });
    assert.equal(feed.contract.ok, false);
    assert.match(feed.contract.failures.join("\n"), /missing Content-Length/);
    assert.match(feed.transferEncoding, /chunked/);

    const book = await probeUrl(`${server.baseUrl}/opds/books/doc1.epub`, { kind: "book" });
    assert.equal(book.contract.ok, false);
    assert.match(book.contract.failures.join("\n"), /Content-Disposition/);
  } finally {
    await server.close();
  }
});

test("fixed app responses pass the CrossInk HTTP contract", async () => {
  const server = await runFixedServer();
  try {
    const headers = { Authorization: server.auth };
    const feed = await probeUrl(`${server.baseUrl}/opds`, { headers, kind: "feed" });
    assert.equal(feed.contract.ok, true, feed.contract.failures.join("; "));
    assert.equal(feed.headers["content-length"], String(feed.bytes.length));
    assert.equal(feed.transferEncoding, "");

    const book = await probeUrl(`${server.baseUrl}/opds/books/doc1.epub`, { headers, kind: "book" });
    assert.equal(book.contract.ok, true, book.contract.failures.join("; "));
    assert.equal(book.headers["content-disposition"], 'attachment; filename="doc1.epub"');
    assert.equal(Number(book.headers["content-length"]), book.bytes.length);
  } finally {
    await server.close();
  }
});

test("checkCrossInkHttpContract flags a size mismatch the firmware would reject", () => {
  const result = checkCrossInkHttpContract({
    url: "http://x/opds",
    status: 200,
    headers: { "content-length": "10" },
    bytes: Buffer.from("short"),
    kind: "feed"
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /size-mismatch/);
});
