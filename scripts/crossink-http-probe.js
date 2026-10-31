#!/usr/bin/env node
// HTTP/1.1 client that follows CrossInk v1.6.1 (SecureHttpClient + HttpDownloader
// + OpdsBookBrowserActivity) limits. Used to prove feed/download responses the
// X3 would accept or reject. Node's fetch hides Transfer-Encoding, so this
// speaks the wire protocol itself.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

import { contentDisposition, epubFilename, isSafeAsciiFilename, sanitizeCrossInkFilename } from "../src/core/filename.js";
import { createApp } from "../src/shell/app.js";

export const CROSSINK = {
  tag: "v1.6.1",
  sha: "9914146eeae7b46b300f475a16c32426fc02ec1f",
  HTTP_TIMEOUT_MS: 60_000,
  MAX_LINE: 4096,
  READ_CHUNK: 2048,
  OPDS_DOWNLOAD_BUFFER_SIZE: 2048,
  MAX_REDIRECTS: 5,
  MAX_FILENAME_BYTES: 150,
  MAX_OPDS_FEED_ENTRIES: 50
};

// Exact first-try download from OpdsBookBrowserActivity::downloadBook +
// HttpDownloader::runGetWolfSsl (pin above). GET only; no Accept; no HEAD;
// Range only if resumePartial (OPDS leaves that false).
export const DEVICE_DOWNLOAD = {
  method: "GET",
  userAgent: `CrossInk-ESP32-${CROSSINK.tag.replace(/^v/, "")}`,
  connection: "keep-alive"
};

export function deviceHeaders({ authorization } = {}) {
  const headers = {
    "User-Agent": DEVICE_DOWNLOAD.userAgent,
    Connection: DEVICE_DOWNLOAD.connection
  };
  if (authorization) headers.Authorization = authorization;
  return headers;
}

export function checkCrossInkHttpContract({ url, status, headers, bytes, kind, headerLineMax = 0 }) {
  const failures = [];
  const notes = [];
  const get = (name) => {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) ?? "";
    return headers[name] ?? headers[name.toLowerCase()] ?? "";
  };
  const contentLength = get("content-length");
  const transferEncoding = get("transfer-encoding");
  const contentDispositionHeader = get("content-disposition");

  if (status !== 200) failures.push(`status ${status}`);
  if (!contentLength) {
    failures.push(
      `missing Content-Length (Transfer-Encoding=${transferEncoding || "none"}). CrossInk HttpDownloader then leaves total=0; a dropped chunked body is STR_FETCH_FEED_FAILED`
    );
  } else if (Number(contentLength) !== bytes.length) {
    failures.push(`Content-Length ${contentLength} != body ${bytes.length} (HttpDownloader size-mismatch → HTTP_ERROR)`);
  } else {
    notes.push(`Content-Length=${contentLength}`);
  }
  if (headerLineMax >= CROSSINK.MAX_LINE) {
    failures.push(`a header line is ${headerLineMax} bytes; SecureHttpClient MAX_LINE=${CROSSINK.MAX_LINE} aborts the header parse`);
  }
  if (kind === "book") {
    if (!contentDispositionHeader) {
      failures.push("missing Content-Disposition");
    } else if (contentDispositionHeader.length >= CROSSINK.MAX_LINE) {
      failures.push(`Content-Disposition is ${contentDispositionHeader.length} bytes (>= MAX_LINE ${CROSSINK.MAX_LINE})`);
    } else {
      const filename = /filename="([^"]*)"/.exec(contentDispositionHeader)?.[1] ?? "";
      if (!isSafeAsciiFilename(filename)) {
        failures.push(`Content-Disposition filename is not short ASCII FAT32-safe: ${contentDispositionHeader}`);
      } else {
        notes.push(`filename=${filename}`);
      }
      if (/filename\*=/.test(contentDispositionHeader) && /%[A-F0-9]{2}/i.test(contentDispositionHeader)) {
        failures.push("Content-Disposition still carries a UTF-8 filename* (production titles include :, em dashes, quotes, $)");
      }
    }
    try {
      const files = unzipSync(bytes);
      if (!files["META-INF/container.xml"]?.length) {
        failures.push("EPUB failed CrossInk download validate (META-INF/container.xml missing or empty)");
      }
    } catch (error) {
      failures.push(`EPUB is not a zip CrossInk can open: ${error.message}`);
    }
  }
  return { ok: failures.length === 0, failures, notes, url, status, bytes: bytes.length };
}

export function deviceFilenameFor(book, format = "author-title") {
  const base =
    !book.author ? book.title : !book.title ? book.author : format === "title-author" ? `${book.title} - ${book.author}` : `${book.author} - ${book.title}`;
  return `${sanitizeCrossInkFilename(base)}.epub`;
}

export async function rawGet(url, { headers = {}, timeoutMs = CROSSINK.HTTP_TIMEOUT_MS } = {}) {
  const target = new URL(url);
  const started = Date.now();
  const incoming = createIncoming();
  const socket = await openSocket(target, timeoutMs);
  socket.on("data", (chunk) => incoming.push(chunk));
  socket.on("end", () => incoming.end());
  socket.on("error", (error) => incoming.fail(error));
  try {
    const requestHeaders = {
      Host: target.host,
      ...deviceHeaders(),
      ...headers
    };
    let request = `GET ${target.pathname}${target.search} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(requestHeaders)) request += `${name}: ${value}\r\n`;
    request += "\r\n";
    socket.write(request);

    const headerDeadline = Date.now() + timeoutMs;
    const { status, headers: responseHeaders, headerLineMax } = await readHeaders(incoming, headerDeadline);
    const transferEncoding = (responseHeaders["transfer-encoding"] ?? "").toLowerCase();
    const contentLengthHeader = responseHeaders["content-length"];
    let body;
    let complete = false;
    if (transferEncoding.includes("chunked")) {
      const decoded = await readChunked(incoming, timeoutMs);
      body = decoded.body;
      complete = decoded.complete;
    } else if (contentLengthHeader !== undefined) {
      const decoded = await readFixed(incoming, Number(contentLengthHeader), timeoutMs);
      body = decoded.body;
      complete = decoded.complete;
    } else {
      const decoded = await readUntilClose(incoming, timeoutMs);
      body = decoded.body;
      complete = decoded.complete;
    }
    return {
      status,
      headers: responseHeaders,
      bytes: body,
      headerLineMax,
      complete,
      transferEncoding,
      ms: Date.now() - started
    };
  } finally {
    socket.destroy();
  }
}

function openSocket(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    const socket =
      target.protocol === "https:"
        ? tlsConnect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname, timeout: timeoutMs }, () => resolve(socket))
        : connect({ host: target.hostname, port: Number(target.port || 80) }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`idle timeout ${timeoutMs} ms`));
    });
    socket.once("error", onError);
  });
}

function createIncoming() {
  const chunks = [];
  let offset = 0;
  let ended = false;
  let failed = null;
  let wake = null;
  return {
    push(chunk) {
      chunks.push(chunk);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    fail(error) {
      failed = error;
      wake?.();
    },
    async readByte(deadline) {
      while (true) {
        if (failed) throw failed;
        if (chunks.length > 0) {
          const byte = chunks[0][offset];
          offset += 1;
          if (offset >= chunks[0].length) {
            chunks.shift();
            offset = 0;
          }
          return byte;
        }
        if (ended) return null;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => {
          wake = resolve;
          const remain = Math.max(0, deadline - Date.now());
          const timer = setTimeout(resolve, remain);
          const prev = wake;
          wake = () => {
            clearTimeout(timer);
            prev();
          };
        });
        wake = null;
      }
    },
    async readExact(count, deadline) {
      const out = Buffer.alloc(count);
      for (let i = 0; i < count; i++) {
        const byte = await this.readByte(deadline);
        if (byte === null) return { body: out.subarray(0, i), complete: false };
        out[i] = byte;
      }
      return { body: out, complete: true };
    }
  };
}

async function readHeaders(incoming, headerDeadline) {
  let headerLineMax = 0;
  const headers = {};
  let status = 0;
  let sawStatus = false;

  while (true) {
    const line = await readLine(incoming, headerDeadline);
    headerLineMax = Math.max(headerLineMax, line.rawLength);
    if (line.rawLength >= CROSSINK.MAX_LINE) {
      throw Object.assign(new Error(`header line ${line.rawLength} bytes (>= MAX_LINE ${CROSSINK.MAX_LINE})`), {
        code: "HEADER_LINE_TOO_LONG",
        headerLineMax: line.rawLength
      });
    }
    if (!sawStatus) {
      status = Number(line.text.slice(9, 12));
      sawStatus = true;
      continue;
    }
    if (line.text === "") return { status, headers, headerLineMax };
    const colon = line.text.indexOf(":");
    if (colon === -1) continue;
    const name = line.text.slice(0, colon).toLowerCase();
    headers[name] = line.text.slice(colon + 1).replace(/^ /, "");
  }
}

async function readLine(incoming, deadline) {
  let text = "";
  let rawLength = 0;
  while (true) {
    const ch = await incoming.readByte(deadline);
    if (ch === null) throw new Error("header timeout");
    rawLength += 1;
    if (ch === 0x0a) {
      if (text.endsWith("\r")) text = text.slice(0, -1);
      return { text, rawLength };
    }
    if (rawLength >= CROSSINK.MAX_LINE) return { text, rawLength };
    text += String.fromCharCode(ch);
  }
}

async function readFixed(incoming, count, timeoutMs) {
  return incoming.readExact(count, Date.now() + timeoutMs);
}

async function readUntilClose(incoming, timeoutMs) {
  const chunks = [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const byte = await incoming.readByte(deadline);
    if (byte === null) return { body: Buffer.concat(chunks), complete: true };
    chunks.push(Buffer.from([byte]));
  }
}

async function readChunked(incoming, timeoutMs) {
  const body = [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const sizeLine = await readLine(incoming, deadline);
    const size = Number.parseInt(sizeLine.text.split(";", 1)[0], 16);
    if (!Number.isFinite(size)) return { body: Buffer.concat(body), complete: false };
    if (size === 0) {
      await readLine(incoming, deadline);
      return { body: Buffer.concat(body), complete: true };
    }
    const chunk = await incoming.readExact(size, deadline);
    if (!chunk.complete) return { body: Buffer.concat([...body, chunk.body]), complete: false };
    body.push(chunk.body);
    const crlf = await incoming.readExact(2, deadline);
    if (!crlf.complete) return { body: Buffer.concat(body), complete: false };
  }
}

export async function probeUrl(url, { headers = {}, kind, timeoutMs = CROSSINK.HTTP_TIMEOUT_MS } = {}) {
  const response = await rawGet(url, { headers, timeoutMs });
  const contract = checkCrossInkHttpContract({
    url,
    status: response.status,
    headers: response.headers,
    bytes: response.bytes,
    kind,
    headerLineMax: response.headerLineMax
  });
  if (!response.complete) contract.failures.push("responseComplete() == false (HttpDownloader → HTTP_ERROR / Failed to fetch feed)");
  contract.ok = contract.failures.length === 0;
  contract.ms = response.ms;
  contract.complete = response.complete;
  contract.transferEncoding = response.transferEncoding;
  return { ...response, contract };
}

const HOSTILE_TITLE = 'Why $FOO failed: “evals” — a report';

function authorization(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export async function runLegacyServer() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:readwise-opds:root</id>
  <title>Readwise</title>
  <updated>2026-10-31T00:00:00Z</updated>
  <link rel="self" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="http://127.0.0.1/opds"/>
  <entry>
    <title>Inbox</title>
    <id>urn:readwise-opds:inbox</id>
    <updated>2026-10-31T00:00:00Z</updated>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="http://127.0.0.1/opds/inbox"/>
  </entry>
</feed>
`;
  const epub = Buffer.from("PK\x03\x04not-a-real-epub-but-has-length");
  const filename = `${HOSTILE_TITLE}.epub`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, " ");
  const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

  const server = createServer((req, res) => {
    if (req.url === "/opds") {
      const body = Buffer.from(xml);
      res.chunkedEncoding = true;
      res.writeHead(200, {
        "Content-Type": "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "private, no-store"
      });
      res.write(body.subarray(0, 200));
      res.write(body.subarray(200));
      res.end();
      return;
    }
    if (req.url === "/opds/books/doc1.epub") {
      res.writeHead(200, {
        "Content-Type": "application/epub+zip",
        "Content-Length": String(epub.length),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store"
      });
      res.end(epub);
      return;
    }
    res.writeHead(404);
    res.end("Not found\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    disposition,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

export async function runFixedServer({ log = () => {} } = {}) {
  const env = { READWISE_TOKEN: "rw", OPDS_USERNAME: "u", OPDS_PASSWORD: "p" };
  const html = "<p>Body</p>";
  const article = {
    id: "doc1",
    title: HOSTILE_TITLE,
    author: "Hamel Husain",
    category: "article",
    site_name: "Blog",
    word_count: 12,
    summary: "s",
    source_url: "https://cdn.example/a",
    image_url: null,
    saved_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    language: "en",
    html_content: html
  };
  const app = createApp({
    env,
    fetch: async (input) => {
      const url = String(input);
      if (url.startsWith("https://readwise.io/api/v3/list/")) {
        return new Response(JSON.stringify({ count: 1, nextPageCursor: null, results: [article] }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    },
    now: () => new Date("2026-10-31T00:00:00Z"),
    log
  });
  const seen = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    seen.push({
      method: req.method,
      path: url.pathname + url.search,
      userAgent: req.headers["user-agent"] ?? "",
      authorization: Boolean(req.headers.authorization),
      accept: req.headers.accept ?? "",
      range: req.headers.range ?? "",
      connection: req.headers.connection ?? ""
    });
    const request = new Request(url, { headers: req.headers });
    const bookMatch = /^\/opds\/books\/([^/]+)$/.exec(url.pathname);
    let response;
    if (url.pathname === "/opds") response = await app.feed(request);
    else if (bookMatch) {
      url.searchParams.set("file", decodeURIComponent(bookMatch[1]));
      response = await app.book(new Request(url, { headers: req.headers }), decodeURIComponent(bookMatch[1]).replace(/\.epub$/, ""));
    } else {
      url.searchParams.set("location", url.pathname.split("/").pop());
      response = await app.feed(new Request(url, { headers: req.headers }));
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    auth: authorization("u", "p"),
    seen,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

function printResult(label, result) {
  const tag = result.contract.ok ? "PASS" : "FAIL";
  const extra = result.contract.ok ? result.contract.notes.join(", ") : result.contract.failures.join("; ");
  console.log(`${tag} ${label}: ${result.status} ${result.bytes.length}B te=${result.transferEncoding || "identity"} ${result.ms}ms — ${extra}`);
}

function printSeen(label, seen) {
  const extra = [
    `ua=${seen.userAgent || "(none)"}`,
    `authorization=${seen.authorization}`,
    `connection=${seen.connection || "(none)"}`,
    `accept=${seen.accept || "(none)"}`,
    `range=${seen.range || "(none)"}`
  ].join(" ");
  console.log(`seen ${label}: ${seen.method} ${seen.path} ${extra}`);
}

export async function runSelfTest() {
  const failures = [];
  console.log(`CrossInk pin: ${CROSSINK.tag} (${CROSSINK.sha})`);
  console.log(`limits: HTTP_TIMEOUT_MS=${CROSSINK.HTTP_TIMEOUT_MS} MAX_LINE=${CROSSINK.MAX_LINE} filename=${CROSSINK.MAX_FILENAME_BYTES}`);
  console.log(`device filename for hostile title: ${deviceFilenameFor({ title: HOSTILE_TITLE, author: "Hamel Husain" })}`);
  console.log(
    `device download: ${DEVICE_DOWNLOAD.method} User-Agent=${DEVICE_DOWNLOAD.userAgent} Connection=${DEVICE_DOWNLOAD.connection} (no Accept, no Range, no HEAD)`
  );

  console.log("\n=== BEFORE (production-like: chunked feed, title in Content-Disposition) ===");
  const legacy = await runLegacyServer();
  try {
    const feed = await probeUrl(`${legacy.baseUrl}/opds`, { kind: "feed" });
    printResult("legacy /opds", feed);
    if (feed.contract.ok) failures.push("legacy feed unexpectedly passed");
    const book = await probeUrl(`${legacy.baseUrl}/opds/books/doc1.epub`, { kind: "book" });
    printResult("legacy /opds/books/doc1.epub", book);
    if (book.contract.ok) failures.push("legacy book unexpectedly passed");
    console.log(`legacy Content-Disposition: ${legacy.disposition}`);
  } finally {
    await legacy.close();
  }

  console.log("\n=== AFTER (fixed app: Content-Length on feeds, ASCII id filename) ===");
  const logs = [];
  const fixed = await runFixedServer({ log: (entry) => logs.push(entry) });
  try {
    const headers = deviceHeaders({ authorization: fixed.auth });
    const feed = await probeUrl(`${fixed.baseUrl}/opds`, { headers, kind: "feed" });
    printResult("fixed /opds", feed);
    if (!feed.contract.ok) failures.push(`fixed feed failed: ${feed.contract.failures.join("; ")}`);
    const book = await probeUrl(`${fixed.baseUrl}/opds/books/doc1.epub`, { headers, kind: "book" });
    printResult("fixed /opds/books/doc1.epub", book);
    if (!book.contract.ok) failures.push(`fixed book failed: ${book.contract.failures.join("; ")}`);
    console.log(`fixed Content-Disposition: attachment; filename="${epubFilename("doc1")}"`);
    console.log(`contentDisposition() => ${contentDisposition(epubFilename("doc1"))}`);
  } finally {
    await fixed.close();
  }

  console.log("\n=== DEVICE DOWNLOAD (CrossInk v1.6.1 wolfSSL GET, same Basic as feeds) ===");
  const deviceLogs = [];
  const deviceServer = await runFixedServer({ log: (entry) => deviceLogs.push(entry) });
  try {
    const noAuth = await rawGet(`${deviceServer.baseUrl}/opds/books/doc1.epub`, { headers: deviceHeaders() });
    const noAuthTag = noAuth.status === 401 ? "FAIL-before" : "UNEXPECTED";
    console.log(
      `${noAuthTag} device GET without Authorization: ${noAuth.status} ${noAuth.bytes.length}B (firmware would show "Download failed")`
    );
    if (noAuth.status !== 401) failures.push(`unauthenticated device download expected 401, got ${noAuth.status}`);
    const noAuthLog = deviceLogs.find((entry) => entry.status === 401);
    if (!noAuthLog) failures.push("401 device download produced no request log");
    else {
      console.log(`log 401: ${JSON.stringify(noAuthLog)}`);
      if (noAuthLog.authorization !== false) failures.push("401 log claimed Authorization was present");
      if (/Basic |u:p|"p"/.test(JSON.stringify(noAuthLog))) failures.push("401 log leaked credentials");
    }

    const withAuth = await probeUrl(`${deviceServer.baseUrl}/opds/books/doc1.epub`, {
      headers: deviceHeaders({ authorization: deviceServer.auth }),
      kind: "book"
    });
    printResult("device GET with same Basic as feeds", withAuth);
    if (!withAuth.contract.ok) failures.push(`device download failed: ${withAuth.contract.failures.join("; ")}`);
    const bookSeen = deviceServer.seen.find((row) => row.path === "/opds/books/doc1.epub" && row.authorization);
    if (!bookSeen) failures.push("authenticated device download was not observed");
    else {
      printSeen("device download", bookSeen);
      if (bookSeen.method !== "GET") failures.push(`device download method ${bookSeen.method}`);
      if (bookSeen.userAgent !== DEVICE_DOWNLOAD.userAgent) failures.push(`device download UA ${bookSeen.userAgent}`);
      if (bookSeen.connection !== DEVICE_DOWNLOAD.connection) {
        failures.push(`device download Connection ${bookSeen.connection}`);
      }
      if (bookSeen.accept) failures.push(`device download sent Accept: ${bookSeen.accept}`);
      if (bookSeen.range) failures.push(`device download sent Range: ${bookSeen.range}`);
    }
    const bookLog = deviceLogs.find((entry) => entry.path === "/opds/books/doc1.epub" && entry.status === 200);
    if (!bookLog) failures.push("200 device download produced no request log");
    else {
      console.log(`log 200: ${JSON.stringify(bookLog)}`);
      if (bookLog.authorization !== true) failures.push("200 log missing authorization=true");
      if (bookLog.userAgent !== DEVICE_DOWNLOAD.userAgent) failures.push(`200 log UA ${bookLog.userAgent}`);
      if (/Basic |u:p/.test(JSON.stringify(bookLog))) failures.push("200 log leaked credentials");
    }
  } finally {
    await deviceServer.close();
  }

  const ok = failures.length === 0;
  console.log(`\n${ok ? "SELF-TEST PASS" : `${failures.length} SELF-TEST FAILED`}`);
  return ok;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test" || args.length === 0) {
    const ok = await runSelfTest();
    process.exit(ok ? 0 : 1);
  }
  const url = args[0];
  const kind = args.includes("--book") ? "book" : "feed";
  const user = process.env.OPDS_USERNAME;
  const password = process.env.OPDS_PASSWORD;
  const headers = deviceHeaders(user && password ? { authorization: authorization(user, password) } : {});
  const result = await probeUrl(url, { headers, kind });
  printResult(url, result);
  process.exit(result.contract.ok ? 0 : 1);
}
