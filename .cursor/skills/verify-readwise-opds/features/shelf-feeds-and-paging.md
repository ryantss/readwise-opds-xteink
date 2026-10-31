# Shelf feeds and paging

Each shelf is an OPDS acquisition feed of readable Reader documents, 50 entries per page, newest-saved first, with a `rel="next"` link when more remain. CrossInk's OPDS browser shows that page and follows next.

## Sub-features

- `shelf-inbox` lists Inbox articles (Reader `new` location) as `BOOK` entries with EPUB acquisition links.
- `shelf-shortlist` lists Shortlist articles as `BOOK` entries with EPUB acquisition links.
- `shelf-later` lists Later the same way.
- `shelf-archive` lists Archive the same way.
- `shelf-page-size` returns 50 `BOOK` entries on fixture page 1.
- `shelf-next` exposes a next-page URL that CrossInk reports as `next page:`.
- `shelf-page-2` returns the remaining fixture article (1 on the mocked catalog).

## How to get to it (user POV)

- From the root menu, open Inbox, Shortlist, Later or Archive. CrossInk `GET`s `/opds/inbox`, `/opds/shortlist`, `/opds/later` or `/opds/archive`.
- On a full page, choose the next-page control. CrossInk `GET`s the `rel="next"` href (`/opds/<shelf>?cursor=<cursor>`).
- The fixture cursor for page 2 is `page2`. Live Readwise cursors are opaque; never invent one.

## Driving it with opds-cli

Preconditions:

- `./scripts/opds-cli doctor` exits 0.
- The fixture catalog is the one under test (51 documents per shelf, page size 50).
- Host tools for `walk` are present (`clang++` or `g++`, libexpat).

- **Open Inbox.** Run `./scripts/opds-cli walk --shelf inbox --feature shelf-feeds-and-paging`. The walk fetches `/opds`, follows the Inbox `NAV` href, then follows `next page:`.
- **Page 1 size.** Evidence `<shelf>-page1.opds.txt` has `books: 50` and `truncated: no`. A page with more than 50 `BOOK` lines, or `truncated: yes`, is a failure: CrossInk's `MAX_OPDS_FEED_ENTRIES` is 50 and this server must page at that cap, not hide the overflow.
- **Next page.** The same file has a non-empty `next page:` URL containing `/opds/inbox?cursor=`.
- **Page 2.** `<shelf>-page2.opds.txt` has `books: 1` and a 200 status. An empty page 2 after a next link is a failure.
- **Other shelves.** Repeat with `--shelf shortlist`, `--shelf later` and `--shelf archive`. Do not mark those entry points verified from the Inbox walk alone.
- **Targeted fetch.** `./scripts/opds-cli fetch /opds/inbox --out .cache/verify-opds/evidence/<run>/inbox.xml` is the HTTP-only form of page 1. Still parse it with CrossInk before calling the shelf verified.
- **Proof.** `walk.json` has passing steps for page 1 count, `truncated=no`, next page, and page 2 count. The observable end state is 50 CrossInk `BOOK` entries, a next URL, and one `BOOK` on page 2.

## Gotchas

- CrossInk `OpdsParser` keeps at most `MAX_OPDS_FEED_ENTRIES` (50) entries. A feed that emits 51 without paging will parse as `truncated: yes` and drop the rest. Report that. Do not lower the expected count to make the walk pass.
- The first Shortlist title and the first Later author in the fixture are padded past CrossInk's 160-character title cap and 120-character author cap. Assert entry counts and hrefs, not full-string title equality against the Atom XML.
- `?cursor=` on the shelf URL is the Readwise page cursor, forwarded as `pageCursor`. The fixture understands `page2`. A made-up cursor returns the first page and will fail the page-2 count.
- PDFs, videos and highlights are omitted from feeds. The fixture only seeds `article` documents, so a missing book is a catalog bug, not a filtered category.
