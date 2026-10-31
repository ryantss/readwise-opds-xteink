import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEVICE_DOWNLOAD,
  checkCrossInkHttpContract,
  deviceHeaders,
  probeUrl,
  rawGet,
  runFixedServer,
  runLegacyServer
} from "../scripts/crossink-http-probe.js";

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
    const headers = deviceHeaders({ authorization: server.auth });
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

test("device download GET uses the same Basic auth as feeds and is logged", async () => {
  assert.equal(DEVICE_DOWNLOAD.method, "GET");
  assert.equal(DEVICE_DOWNLOAD.userAgent, "CrossInk-ESP32-1.6.1");
  assert.equal(DEVICE_DOWNLOAD.connection, "keep-alive");

  const logs = [];
  const server = await runFixedServer({ log: (entry) => logs.push(entry) });
  try {
    const denied = await rawGet(`${server.baseUrl}/opds/books/doc1.epub`, { headers: deviceHeaders() });
    assert.equal(denied.status, 401);
    const deniedLog = logs.find((entry) => entry.status === 401);
    assert.ok(deniedLog);
    assert.equal(deniedLog.path, "/opds/books/doc1.epub");
    assert.equal(deniedLog.authorization, false);
    assert.equal(deniedLog.userAgent, DEVICE_DOWNLOAD.userAgent);
    assert.doesNotMatch(JSON.stringify(deniedLog), /Basic |u:p/);

    const book = await probeUrl(`${server.baseUrl}/opds/books/doc1.epub`, {
      headers: deviceHeaders({ authorization: server.auth }),
      kind: "book"
    });
    assert.equal(book.contract.ok, true, book.contract.failures.join("; "));
    const seen = server.seen.find((row) => row.path === "/opds/books/doc1.epub" && row.authorization);
    assert.ok(seen);
    assert.equal(seen.method, "GET");
    assert.equal(seen.userAgent, DEVICE_DOWNLOAD.userAgent);
    assert.equal(seen.connection, DEVICE_DOWNLOAD.connection);
    assert.equal(seen.accept, "");
    assert.equal(seen.range, "");
    const bookLog = logs.find((entry) => entry.path === "/opds/books/doc1.epub" && entry.status === 200);
    assert.ok(bookLog);
    assert.equal(bookLog.authorization, true);
    assert.ok(bookLog.bytes > 0);
    assert.doesNotMatch(JSON.stringify(bookLog), /Basic |u:p/);
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
