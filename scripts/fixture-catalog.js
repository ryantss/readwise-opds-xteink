// Local OPDS catalog backed by a mocked Readwise API. Used by the CrossPoint
// and CrossInk verify scripts so they can run without a real account.
import { createServer } from "node:http";

import sharp from "sharp";

import { createApp } from "../src/shell/app.js";

export const FIXTURE_USERNAME = "fixture-reader";
export const FIXTURE_PASSWORD = "fixture-password";

const PAGE = 50;
const SHELF_SIZES = { shortlist: 51, later: 51, archive: 51 };
const IMAGE_URL = "https://cdn.example/cover.png";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

const LONG_TITLE =
  "A fixture title padded so CrossInk's 160-character OpdsParser cap can be compared against CrossPoint: " +
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const LONG_AUTHOR =
  "A fixture author padded past CrossInk's 120-character cap xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

export async function startFixtureCatalog({ port = 0 } = {}) {
  const png = await sharp({
    create: { width: 200, height: 120, channels: 3, background: { r: 40, g: 80, b: 160 } }
  })
    .png()
    .toBuffer();

  const shelves = Object.fromEntries(
    Object.entries(SHELF_SIZES).map(([location, count]) => [location, docsFor(location, count)])
  );
  const byId = new Map(Object.values(shelves).flat().map((doc) => [doc.id, doc]));

  const fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin === "https://readwise.io" && url.pathname === "/api/v3/list/") {
      return readwiseList(url.searchParams, shelves, byId);
    }
    if (url.href.startsWith("https://cdn.example/")) {
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    return new Response("not found", { status: 404 });
  };

  const app = createApp({
    env: {
      READWISE_TOKEN: "fixture-token",
      OPDS_USERNAME: FIXTURE_USERNAME,
      OPDS_PASSWORD: FIXTURE_PASSWORD
    },
    fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => new Date("2026-10-28T00:00:00Z"),
    log() {}
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const request = new Request(url, { headers: req.headers });
    const bookMatch = /^\/opds\/books\/([^/]+)$/.exec(url.pathname);
    const shelfMatch = /^\/opds\/([^/]+)$/.exec(url.pathname);

    let response;
    if (url.pathname === "/opds") {
      response = await app.feed(request);
    } else if (bookMatch) {
      url.searchParams.set("file", decodeURIComponent(bookMatch[1]));
      response = await app.book(new Request(url, { headers: req.headers }), decodeURIComponent(bookMatch[1]).replace(/\.epub$/, ""));
    } else if (shelfMatch) {
      url.searchParams.set("location", decodeURIComponent(shelfMatch[1]));
      response = await app.feed(new Request(url, { headers: req.headers }));
    } else {
      response = new Response("Not found\n", { status: 404 });
    }

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port: bound } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${bound}`,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

function docsFor(location, count) {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    const first = index === 0;
    return {
      id: `${location}-${n}`,
      title: first && location === "shortlist" ? LONG_TITLE : `${titleCase(location)} article ${n} & notes`,
      author: first && location === "later" ? LONG_AUTHOR : first ? "Émile Zola" : `${titleCase(location)} Author ${n}`,
      category: "article",
      site_name: "Fixture Blog",
      word_count: 500 + index,
      summary: "A short fixture summary <with> markup.",
      source_url: `https://cdn.example/${location}/${n}`,
      image_url: IMAGE_URL,
      saved_at: `2026-10-01T12:${String(index % 60).padStart(2, "0")}:00.000000+00:00`,
      updated_at: "2026-10-02T00:00:00.000000+00:00",
      language: "en",
      html_content: `<p>Fixture body for ${location} ${n}.</p><figure><img alt="chart" src="${IMAGE_URL}"/></figure>`
    };
  });
}

function readwiseList(params, shelves, byId) {
  const id = params.get("id");
  if (id) {
    const doc = byId.get(id);
    return json({ count: doc ? 1 : 0, nextPageCursor: null, results: doc ? [doc] : [] });
  }

  const location = params.get("location");
  const docs = shelves[location] ?? [];
  const limit = Number(params.get("limit") || PAGE);
  const cursor = params.get("pageCursor");
  const start = cursor === "page2" ? PAGE : 0;
  const results = docs.slice(start, start + limit);
  const nextPageCursor = start + limit < docs.length ? "page2" : null;
  return json({ count: docs.length, nextPageCursor, results });
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
