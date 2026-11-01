import assert from "node:assert/strict";
import test from "node:test";

import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";

import { encodePageToken } from "../src/core/paging.js";
import { createApp } from "../src/shell/app.js";

const env = { READWISE_TOKEN: "rw-token", OPDS_USERNAME: "reader", OPDS_PASSWORD: "pw" };
const auth = { authorization: `Basic ${Buffer.from("reader:pw").toString("base64")}` };

const article = {
  id: "doc1",
  title: "Claude’s new auto eval tool",
  author: "Hamel Husain",
  category: "article",
  site_name: "Hamel's Blog",
  word_count: 791,
  summary: "Summary.",
  source_url: "https://hamel.dev/blog/posts/claude-auto-evals/",
  image_url: "https://hamel.dev/cover.png",
  saved_at: "2026-10-01T12:33:13.522000+00:00",
  updated_at: "2026-10-02T00:00:00.000000+00:00",
  language: "en"
};

const colourPng = await sharp({
  create: { width: 1200, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } }
})
  .png()
  .toBuffer();

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers ?? {} });
    for (const [prefix, respond] of routes) {
      if (url.startsWith(prefix)) return respond(url);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const silent = { log() {} };

const json = (body, init) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

test("rejects requests without valid credentials", async () => {
  const app = createApp({ env, fetch: fakeFetch([]).fetch, ...silent });

  const response = await app.feed(new Request("https://opds.example.com/opds"));

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /^Basic realm="Readwise OPDS"/);
});

test("root feed is a navigation menu and calls no Readwise API", async () => {
  const { fetch, calls } = fakeFetch([]);
  const app = createApp({ env, fetch, ...silent });

  const response = await app.feed(new Request("https://opds.example.com/opds", { headers: auth }));
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(xml)));
  assert.match(xml, /href="https:\/\/opds.example.com\/opds\/inbox"/);
  assert.match(xml, /href="https:\/\/opds.example.com\/opds\/shortlist"/);
  assert.match(xml, /href="https:\/\/opds.example.com\/opds\/later"/);
  assert.match(xml, /href="https:\/\/opds.example.com\/opds\/archive"/);
  assert.doesNotMatch(xml, /\/opds\/new"/);
  assert.equal(calls.length, 0);
});

test("inbox shelf lists documents from the Reader new location", async () => {
  const { fetch, calls } = fakeFetch([
    [
      "https://readwise.io/api/v3/list/",
      () => json({ count: 1, nextPageCursor: "cur2", results: [article] })
    ]
  ]);
  const app = createApp({ env, fetch, now: () => new Date("2026-10-24T01:02:03Z"), ...silent });

  const response = await app.feed(new Request("https://opds.example.com/api/opds?location=inbox", { headers: auth }));
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.match(xml, /<title>Readwise Inbox<\/title>/);
  assert.match(xml, new RegExp(`href="https://opds.example.com/opds/inbox\\?cursor=${encodePageToken(2, "cur2")}"`));
  assert.doesNotMatch(xml, /rel="previous"/);

  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("location"), "new");
  assert.equal(listUrl.searchParams.get("limit"), "10");
});

test("shelf feed lists readable documents from that location with a next-page link", async () => {
  const { fetch, calls } = fakeFetch([
    [
      "https://readwise.io/api/v3/list/",
      () => json({ count: 2, nextPageCursor: "cur2", results: [article, { ...article, id: "pdf1", category: "pdf" }] })
    ]
  ]);
  const app = createApp({ env, fetch, now: () => new Date("2026-10-24T01:02:03Z"), ...silent });

  const response = await app.feed(new Request("https://opds.example.com/api/opds?location=later", { headers: auth }));
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(xml)));
  assert.match(xml, /<title>Readwise Later<\/title>/);
  assert.match(xml, /<updated>2026-10-24T01:02:03.000Z<\/updated>/);
  assert.match(xml, /href="https:\/\/opds.example.com\/opds\/books\/doc1.epub"/);
  assert.doesNotMatch(xml, /pdf1/);
  assert.match(xml, new RegExp(`href="https://opds.example.com/opds/later\\?cursor=${encodePageToken(2, "cur2")}"`));
  assert.doesNotMatch(xml, /rel="previous"/);

  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("location"), "later");
  assert.equal(listUrl.searchParams.get("limit"), "10");
  assert.equal(listUrl.searchParams.get("pageCursor"), null);
  assert.equal(calls[0].headers.Authorization, "Token rw-token");
});

test("shelf feed passes the page cursor through to Readwise and honours BASE_URL", async () => {
  const { fetch, calls } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ count: 1, nextPageCursor: null, results: [article] })]
  ]);
  const app = createApp({ env: { ...env, BASE_URL: "https://reader.example.org/" }, fetch, ...silent });

  const page2 = encodePageToken(2, "cur2");
  const xml = await (
    await app.feed(new Request(`http://internal/api/opds?location=archive&cursor=${page2}`, { headers: auth }))
  ).text();

  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("location"), "archive");
  assert.equal(listUrl.searchParams.get("pageCursor"), "cur2");
  assert.match(xml, /href="https:\/\/reader.example.org\/opds\/books\/doc1.epub"/);
  assert.match(xml, /rel="previous"/);
  assert.match(xml, /href="https:\/\/reader.example.org\/opds\/archive"/);
  assert.doesNotMatch(xml, /rel="next"/);
});

test("shelf page 2 previous returns the first page's entries without skipping", async () => {
  const page1 = [article, { ...article, id: "doc2", title: "Second" }];
  const page2 = [{ ...article, id: "doc11", title: "Eleventh" }];
  const { fetch, calls } = fakeFetch([
    [
      "https://readwise.io/api/v3/list/",
      (url) => {
        const cursor = new URL(url).searchParams.get("pageCursor");
        if (!cursor) return json({ count: 12, nextPageCursor: "rw1", results: page1 });
        if (cursor === "rw1") return json({ count: 12, nextPageCursor: null, results: page2 });
        return json({ count: 0, nextPageCursor: null, results: [] });
      }
    ]
  ]);
  const app = createApp({ env, fetch, now: () => new Date("2026-10-24T01:02:03Z"), ...silent });

  const first = await (await app.feed(new Request("https://opds.example.com/api/opds?location=inbox", { headers: auth }))).text();
  assert.match(first, /doc1\.epub/);
  assert.doesNotMatch(first, /doc11/);

  const second = await (
    await app.feed(
      new Request(`https://opds.example.com/api/opds?location=inbox&cursor=${encodePageToken(2, "rw1")}`, { headers: auth })
    )
  ).text();
  assert.match(second, /doc11/);
  assert.doesNotMatch(second, /doc1\.epub/);
  assert.match(second, /rel="previous"[^>]+href="https:\/\/opds.example.com\/opds\/inbox"/);
  assert.doesNotMatch(second, /rel="next"/);

  const back = await (await app.feed(new Request("https://opds.example.com/api/opds?location=inbox", { headers: auth }))).text();
  assert.match(back, /doc1\.epub/);
  assert.match(back, /doc2\.epub/);
  assert.doesNotMatch(back, /doc11/);
  assert.equal(calls.filter((call) => new URL(call.url).searchParams.get("pageCursor") === "rw1").length, 1);
});

test("a page can have fewer than 10 entries after non-readable docs are filtered", async () => {
  const results = Array.from({ length: 10 }, (_, index) =>
    index === 3
      ? { ...article, id: `pdf${index}`, category: "pdf" }
      : { ...article, id: `doc${index}`, title: `Article ${index}` }
  );
  const { fetch } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ count: 10, nextPageCursor: "rw1", results })]
  ]);
  const app = createApp({ env, fetch, ...silent });
  const xml = await (await app.feed(new Request("https://opds.example.com/api/opds?location=later", { headers: auth }))).text();
  assert.equal([...xml.matchAll(/<entry>/g)].length, 9);
  assert.doesNotMatch(xml, /pdf3/);
});

test("unknown shelf is a 404 without calling Readwise", async () => {
  const { fetch, calls } = fakeFetch([]);
  const app = createApp({ env, fetch, ...silent });

  const response = await app.feed(new Request("https://x/api/opds?location=feed", { headers: auth }));
  const asNew = await app.feed(new Request("https://x/api/opds?location=new", { headers: auth }));

  assert.equal(response.status, 404);
  assert.equal(asNew.status, 404);
  assert.equal(calls.length, 0);
});

test("feed maps Readwise rate limiting to 503 with Retry-After", async () => {
  const { fetch } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } })]
  ]);
  const app = createApp({ env, fetch, ...silent });

  const response = await app.feed(new Request("https://opds.example.com/api/opds?location=shortlist", { headers: auth }));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "12");
});

test("book builds an EPUB with grayscale baseline JPEGs and drops images that fail", async () => {
  const html = `<p>Intro</p><figure><img alt="chart" src="images/chart.png"/></figure><p><img src="https://gone.example/x.png"></p>`;
  const { fetch, calls } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ count: 1, nextPageCursor: null, results: [{ ...article, html_content: html }] })],
    ["https://hamel.dev/", () => new Response(colourPng, { headers: { "content-type": "image/png" } })]
  ]);
  const app = createApp({ env, fetch, lookup: publicLookup, ...silent });

  const response = await app.book(new Request("https://opds.example.com/opds/books/doc1.epub", { headers: auth }), "doc1");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/epub+zip");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="doc1.epub"');

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  const files = unzipSync(bytes);
  const chapter = strFromU8(files["OEBPS/chapter.xhtml"]);
  assert.match(chapter, /<figure><img src="images\/img-001.jpg" alt="chart"\/><\/figure><p><\/p>/);
  assert.match(chapter, /<h1>Claude’s new auto eval tool<\/h1>/);
  assert.match(chapter, /<p class="byline">Hamel Husain · Hamel&apos;s Blog<\/p>/);
  assert.ok(files["OEBPS/images/cover.jpg"]);

  const image = await sharp(files["OEBPS/images/img-001.jpg"]).metadata();
  assert.equal(image.format, "jpeg");
  assert.equal(image.isProgressive, false);
  assert.equal(image.channels, 1);
  assert.equal(image.width, 528);
  assert.equal(image.height, 264);

  const docUrl = new URL(calls[0].url);
  assert.equal(docUrl.searchParams.get("id"), "doc1");
  assert.equal(docUrl.searchParams.get("withHtmlContent"), "true");
});

test("book returns 404 for unknown or unreadable documents", async () => {
  const { fetch } = fakeFetch([
    [
      "https://readwise.io/api/v3/list/?id=pdf1",
      () => json({ count: 1, nextPageCursor: null, results: [{ ...article, id: "pdf1", category: "pdf" }] })
    ],
    ["https://readwise.io/api/v3/list/", () => json({ count: 0, nextPageCursor: null, results: [] })]
  ]);
  const app = createApp({ env, fetch, ...silent });

  assert.equal((await app.book(new Request("https://x/opds/books/nope.epub", { headers: auth }), "nope")).status, 404);
  assert.equal((await app.book(new Request("https://x/opds/books/pdf1.epub", { headers: auth }), "pdf1")).status, 404);
});

function loggedApp(overrides = {}) {
  const logs = [];
  const app = createApp({
    env,
    fetch: fakeFetch([]).fetch,
    log: (entry) => logs.push(entry),
    ...overrides
  });
  return { app, logs, requests: () => logs.filter((entry) => entry.event === "request") };
}

function assertSafeRequestLog(entry, expected) {
  assert.equal(entry.event, "request");
  assert.equal(entry.method, expected.method);
  assert.equal(entry.path, expected.path);
  assert.equal(entry.status, expected.status);
  assert.equal(entry.userAgent, expected.userAgent);
  assert.equal(entry.authorization, expected.authorization);
  assert.equal(typeof entry.bytes, "number");
  assert.ok(entry.bytes >= 0);
  assert.equal(typeof entry.ms, "number");
  assert.ok(entry.ms >= 0);
  if (expected.error) {
    assert.equal(entry.error, expected.error);
  } else {
    assert.equal(entry.error, undefined);
  }
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /pw|rw-token|reader:pw|cnJlYWRlcjpwdw==|Authorization: Basic/i);
}

test("401, feeds, books, and errors each emit one request log without credentials", async () => {
  const deviceUa = "CrossInk-ESP32-1.6.1";
  const device = { "user-agent": deviceUa };

  const unauthorized = loggedApp();
  await unauthorized.app.feed(new Request("https://opds.example.com/opds", { headers: device }));
  assert.equal(unauthorized.requests().length, 1);
  assertSafeRequestLog(unauthorized.requests()[0], {
    method: "GET",
    path: "/opds",
    status: 401,
    userAgent: deviceUa,
    authorization: false
  });

  const root = loggedApp();
  await root.app.feed(new Request("https://opds.example.com/opds", { headers: { ...auth, ...device } }));
  assert.equal(root.requests().length, 1);
  assertSafeRequestLog(root.requests()[0], {
    method: "GET",
    path: "/opds",
    status: 200,
    userAgent: deviceUa,
    authorization: true
  });
  assert.ok(root.requests()[0].bytes > 0);

  const { fetch: inboxFetch } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ count: 1, nextPageCursor: null, results: [article] })]
  ]);
  const inbox = loggedApp({ fetch: inboxFetch });
  await inbox.app.feed(
    new Request("https://opds.example.com/api/opds?location=inbox", { headers: { ...auth, ...device } })
  );
  assert.equal(inbox.requests().length, 1);
  assertSafeRequestLog(inbox.requests()[0], {
    method: "GET",
    path: "/opds/inbox",
    status: 200,
    userAgent: deviceUa,
    authorization: true
  });

  const { fetch: bookFetch } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ count: 1, nextPageCursor: null, results: [{ ...article, html_content: "<p>Body</p>" }] })]
  ]);
  const book = loggedApp({ fetch: bookFetch, lookup: publicLookup });
  await book.app.book(
    new Request("https://opds.example.com/api/book?file=doc1.epub", { headers: { ...auth, ...device } }),
    "doc1"
  );
  assert.equal(book.requests().length, 1);
  assertSafeRequestLog(book.requests()[0], {
    method: "GET",
    path: "/opds/books/doc1.epub",
    status: 200,
    userAgent: deviceUa,
    authorization: true
  });
  assert.ok(book.requests()[0].bytes > 0);

  const { fetch: limited } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } })]
  ]);
  const rateLimited = loggedApp({ fetch: limited });
  await rateLimited.app.feed(
    new Request("https://opds.example.com/api/opds?location=shortlist", { headers: { ...auth, ...device } })
  );
  assert.equal(rateLimited.requests().length, 1);
  assertSafeRequestLog(rateLimited.requests()[0], {
    method: "GET",
    path: "/opds/shortlist",
    status: 503,
    userAgent: deviceUa,
    authorization: true,
    error: "Readwise API responded 429"
  });

  const boom = loggedApp({
    fetch: async () => {
      throw new Error("socket hang up");
    }
  });
  await boom.app.feed(
    new Request("https://opds.example.com/api/opds?location=later", { headers: { ...auth, ...device } })
  );
  assert.equal(boom.requests().length, 1);
  assertSafeRequestLog(boom.requests()[0], {
    method: "GET",
    path: "/opds/later",
    status: 500,
    userAgent: deviceUa,
    authorization: true,
    error: "socket hang up"
  });
});

// CrossInk 1.6.1 issue 836: wolfSSL MEMORY_E after 219615 bytes when the
// largest free block is 13300. A finished EPUB has to land under that prefix.
const X3_COMPLETE_READ_BYTES = 219_615;
const EPUB_BYTE_BUDGET = 160 * 1024;

test("a long article stays under the X3 complete-read prefix and keeps its text", async () => {
  const sentence = "The rise of the self-driving company keeps this full sentence.";
  const pictures = 24;
  const noisy = await sharp(pattern(900, 600), { raw: { width: 900, height: 600, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const imgs = Array.from({ length: pictures }, (_, index) => `<img alt="fig${index}" src="https://cdn.example/i${index}.jpg"/>`).join("");
  const html = `<p>${sentence}</p>${imgs}`;
  const doc = {
    ...article,
    id: "01m6ayz163q7d673wrkq76hcn1",
    title: "The Rise of the Self-Driving Company",
    author: "Amjad Masad",
    html_content: html,
    image_url: "https://cdn.example/cover.jpg"
  };
  const { fetch } = fakeFetch([
    ["https://readwise.io/api/v3/list/", () => json({ results: [doc] })],
    ["https://cdn.example/", () => new Response(noisy)]
  ]);
  const app = createApp({ env, fetch, lookup: publicLookup, ...silent });
  const response = await app.book(
    new Request("https://opds.example.com/opds/books/01m6ayz163q7d673wrkq76hcn1.epub", { headers: auth }),
    doc.id
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const chapter = strFromU8(unzipSync(bytes)["OEBPS/chapter.xhtml"]);
  const imageCount = Object.keys(unzipSync(bytes)).filter((name) => name.endsWith(".jpg")).length;

  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  assert.ok(bytes.length <= EPUB_BYTE_BUDGET, `epub ${bytes.length} exceeds ${EPUB_BYTE_BUDGET}`);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("connection"), "close");
  assert.ok(bytes.length <= X3_COMPLETE_READ_BYTES);
  assert.match(chapter, /The rise of the self-driving company keeps this full sentence\./);
  assert.ok(imageCount >= 1 && imageCount < pictures + 1, `kept ${imageCount} jpegs`);
});

function pattern(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    const n = i / 3;
    raw[i] = (n * 17) & 255;
    raw[i + 1] = (n * 29) & 255;
    raw[i + 2] = (n * 13) & 255;
  }
  return raw;
}
