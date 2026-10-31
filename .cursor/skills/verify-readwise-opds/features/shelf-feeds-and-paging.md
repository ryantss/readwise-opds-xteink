# Shelf feeds and paging

Each shelf is an OPDS acquisition feed of readable Reader documents, 10 entries per page, newest-saved first, with a `rel="next"` link when more remain and a `rel="previous"` link on every page after the first. CrossInk's OPDS browser shows that page and follows next and previous.

## Sub-features

- `shelf-inbox` lists Inbox articles (Reader `new` location) as `BOOK` entries with EPUB acquisition links.
- `shelf-shortlist` lists Shortlist articles as `BOOK` entries with EPUB acquisition links.
- `shelf-later` lists Later the same way.
- `shelf-archive` lists Archive the same way.
- `shelf-page-size` returns 10 `BOOK` entries on fixture page 1 (fewer only if non-readable docs were filtered from that Readwise page).
- `shelf-next` exposes a next-page URL that CrossInk reports as `next page:`.
- `shelf-previous` exposes a previous-page URL that CrossInk reports as `prev page:` on pages after the first.
- `shelf-page-2` returns the next 10 fixture articles.

## How to get to it (user POV)

- From the root menu, open Inbox, Shortlist, Later or Archive. CrossInk `GET`s `/opds/inbox`, `/opds/shortlist`, `/opds/later` or `/opds/archive`.
- On a full page, choose the next-page control. CrossInk `GET`s the `rel="next"` href (`/opds/<shelf>?cursor=<token>`).
- On page 2 or later, choose the previous-page control. CrossInk `GET`s the `rel="previous"` href.
- Fixture tokens look like `p2.<base64url>`. Live Readwise cursors are wrapped the same way; never invent one.

## Driving it with opds-cli

Preconditions:

- `./scripts/opds-cli doctor` exits 0.
- The fixture catalog is the one under test (51 documents per shelf, page size 10).
- Host tools for `walk` are present (`clang++` or `g++`, libexpat).

- **Open Inbox.** Run `./scripts/opds-cli walk --shelf inbox --feature shelf-feeds-and-paging`. The walk fetches `/opds`, follows the Inbox `NAV` href, follows `next page:`, then follows `prev page:` back.
- **Page 1 size.** Evidence `<shelf>-page1.opds.txt` has `books: 10`, `truncated: no`, a `next page:` URL, and no `prev page:`. A page with more than 50 `BOOK` lines, or `truncated: yes`, is a failure: CrossInk's `MAX_OPDS_FEED_ENTRIES` is 50.
- **Page 2.** `<shelf>-page2.opds.txt` has `books: 10`, a `next page:` URL, and a `prev page:` URL. Entries must not overlap page 1.
- **Previous.** Following `prev page:` from page 2 returns the same `BOOK` hrefs as page 1.
- **Other shelves.** Repeat with `--shelf shortlist`, `--shelf later` and `--shelf archive`. Do not mark those entry points verified from the Inbox walk alone.
- **Targeted fetch.** `./scripts/opds-cli fetch /opds/inbox --out .cache/verify-opds/evidence/<run>/inbox.xml` is the HTTP-only form of page 1. Still parse it with CrossInk before calling the shelf verified.
- **Proof.** `walk.json` has passing steps for page 1 count, `truncated=no`, next only, page 2 count, next and previous, distinct entries, and previous matching page 1.

## Gotchas

- Each feed must send `Content-Length` equal to the body. A chunked feed with no length is what production served to the X3; CrossInk maps a dropped chunked body to "Failed to fetch feed".
- CrossInk `OpdsParser` keeps at most `MAX_OPDS_FEED_ENTRIES` (50) entries. A feed that emits 51 without paging will parse as `truncated: yes` and drop the rest. Report that. Do not lower the expected count to make the walk pass.
- CrossInk accepts `rel="previous"` exactly (`OpdsParser.cpp` 223), not `rel="prev"`. It inserts a Previous Page row from that href (`OpdsBookBrowserActivity.cpp` 579–588). `MAX_PAGE_URL_CHARS` is 768.
- The first Shortlist title and the first Later author in the fixture are padded past CrossInk's 160-character title cap and 120-character author cap. Assert entry counts and hrefs, not full-string title equality against the Atom XML.
- `?cursor=` on the shelf URL is this catalog's page token (`p{N}` or `p{N}.{base64url(readwiseCursor)}`), not the raw Readwise cursor. A made-up cursor returns an empty later page and will fail the page-2 count.
- PDFs, videos and highlights are omitted from feeds after the Readwise fetch, so a live page can have fewer than 10 books. The fixture only seeds `article` documents, so a missing book there is a catalog bug, not a filtered category.
