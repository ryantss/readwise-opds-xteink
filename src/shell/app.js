import { articleToXhtmlBody, chapterDocument, collectImageUrls } from "../core/article.js";
import { isAuthorized } from "../core/auth.js";
import { buildEpub } from "../core/epub.js";
import { buildFeed, buildNavigationFeed, findShelf, isReadable, readwiseLocation } from "../core/feed.js";
import { contentDisposition, epubFilename } from "../core/filename.js";
import { fetchEpubImages } from "./images.js";
import { createReadwiseClient, ReadwiseError } from "./readwise.js";

const FEED_PAGE_SIZE = 50; // CrossPoint holds at most ~62 entries per page
const MAX_IMAGES = 40;
const ACQUISITION_CONTENT_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8";
const NAVIGATION_CONTENT_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8";

export function createApp({ env, fetch = globalThis.fetch, lookup, now = () => new Date(), log = defaultLog }) {
  const readwise = createReadwiseClient({ token: env.READWISE_TOKEN, fetch });
  const credentials = { username: env.OPDS_USERNAME, password: env.OPDS_PASSWORD };

  function baseUrl(request) {
    return (env.BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  }

  async function guarded(request, route, handler) {
    const started = Date.now();
    const line = {
      event: "request",
      method: request.method,
      path: clientPath(request, route),
      userAgent: request.headers.get("user-agent") ?? "",
      authorization: Boolean(request.headers.get("authorization"))
    };

    const finish = (response, error) => {
      const length = response.headers.get("content-length");
      const entry = {
        ...line,
        status: response.status,
        bytes: length !== null ? Number(length) : 0,
        ms: Date.now() - started
      };
      if (error) entry.error = error.message;
      log(entry);
      return response;
    };

    if (!isAuthorized(request.headers.get("authorization"), credentials)) {
      return finish(
        bytesResponse("Unauthorized\n", { "WWW-Authenticate": 'Basic realm="Readwise OPDS", charset="UTF-8"' }, 401)
      );
    }
    try {
      return finish(await handler());
    } catch (error) {
      if (error instanceof ReadwiseError) {
        if (error.status === 429) {
          return finish(
            bytesResponse("Readwise rate limit, try again shortly\n", { "Retry-After": error.retryAfter ?? "60" }, 503),
            error
          );
        }
        return finish(bytesResponse(`Readwise error ${error.status}\n`, {}, 502), error);
      }
      return finish(bytesResponse("Internal error\n", {}, 500), error);
    }
  }

  return {
    // No location: the root menu of shelves. With one: that shelf's documents.
    feed(request) {
      return guarded(request, "feed", async () => {
        const params = new URL(request.url).searchParams;
        const location = params.get("location");
        const updated = now().toISOString();
        const noStore = { "Cache-Control": "private, no-store" };

        if (!location) {
          const xml = buildNavigationFeed({ baseUrl: baseUrl(request), updated });
          return bytesResponse(xml, { "Content-Type": NAVIGATION_CONTENT_TYPE, ...noStore });
        }

        const shelf = findShelf(location);
        if (!shelf) return bytesResponse("Not found\n", {}, 404);

        const cursor = params.get("cursor");
        const { docs, nextCursor } = await readwise.listLocation({
          location: readwiseLocation(shelf),
          cursor,
          limit: FEED_PAGE_SIZE
        });
        const xml = buildFeed({ shelf, docs: docs.filter(isReadable), baseUrl: baseUrl(request), nextCursor, updated });
        return bytesResponse(xml, { "Content-Type": ACQUISITION_CONTENT_TYPE, ...noStore });
      });
    },

    book(request, id) {
      return guarded(request, "book", async () => {
        const doc = id ? await readwise.getDocument(id) : null;
        if (!doc || !isReadable(doc) || !doc.html_content) return bytesResponse("Not found\n", {}, 404);

        const epub = await buildBook(doc, { fetch, lookup, log });
        return new Response(epub, {
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Length": String(epub.length),
            "Content-Disposition": contentDisposition(epubFilename(id)),
            "Cache-Control": "private, no-store"
          }
        });
      });
    }
  };
}

async function buildBook(doc, { fetch, lookup, log }) {
  const title = doc.title?.trim() || "Untitled";
  const imageUrls = collectImageUrls(doc.html_content, doc.source_url, { max: MAX_IMAGES });
  const coverUrl = doc.image_url && /^https?:/.test(doc.image_url) ? doc.image_url : null;
  const fetched = await fetchEpubImages(coverUrl ? [...imageUrls, coverUrl] : imageUrls, { fetch, lookup, log });

  const images = imageUrls
    .filter((url) => fetched.has(url))
    .map((url, index) => ({ url, href: `images/img-${String(index + 1).padStart(3, "0")}.jpg`, bytes: fetched.get(url) }));
  const body = articleToXhtmlBody(doc.html_content, {
    baseUrl: doc.source_url,
    images: new Map(images.map((image) => [image.url, image.href]))
  });
  const language = doc.language || "en";

  return buildEpub({
    id: doc.id,
    title,
    author: doc.author || doc.site_name || "",
    language,
    modified: isoSeconds(doc.updated_at || doc.saved_at),
    chapter: chapterDocument({
      title,
      byline: [doc.author, doc.site_name].filter(Boolean).join(" · "),
      sourceUrl: doc.source_url,
      language,
      body
    }),
    images,
    cover: coverUrl && fetched.has(coverUrl) ? { href: "images/cover.jpg", bytes: fetched.get(coverUrl) } : null
  });
}

// dcterms:modified must be CCYY-MM-DDThh:mm:ssZ.
function isoSeconds(value) {
  const date = new Date(value);
  return (Number.isNaN(date.getTime()) ? new Date(0) : date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Public catalog path, not the Vercel rewrite (/api/opds?location=inbox).
function clientPath(request, route) {
  const url = new URL(request.url);
  if (route === "book") {
    const file = url.searchParams.get("file") || url.pathname.split("/").pop() || "unknown.epub";
    return `/opds/books/${file.endsWith(".epub") ? file : `${file}.epub`}`;
  }
  const location = url.searchParams.get("location");
  if (location) {
    const cursor = url.searchParams.get("cursor");
    return cursor ? `/opds/${location}?cursor=${cursor}` : `/opds/${location}`;
  }
  const shelf = /^\/opds\/([^/]+)$/.exec(url.pathname);
  if (shelf) return `${url.pathname}${url.search}`;
  return "/opds";
}

// Known-length body so Vercel/Node cannot switch the feed to chunked TE.
// CrossInk's wolfSSL client can decode chunked, but HttpDownloader then has
// no Content-Length (progress stays at 0) and any mid-stream drop becomes
// STR_FETCH_FEED_FAILED via responseComplete() == false.
function bytesResponse(body, headers, status = 200) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return new Response(bytes, {
    status,
    headers: { ...headers, "Content-Length": String(bytes.byteLength ?? bytes.length) }
  });
}

function defaultLog(entry) {
  console.log(JSON.stringify(entry));
}
