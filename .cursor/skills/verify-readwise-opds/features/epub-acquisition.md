# EPUB acquisition

Choosing an article downloads it as an EPUB 3 built on the fly: cleaned XHTML, a cover from the Reader preview image, and every kept image as a grayscale baseline JPEG that fits the X3's 528x792 panel.

## Sub-features

- `epub-download` returns `200` and `Content-Type: application/epub+zip` for a `BOOK` href.
- `epub-zip` starts with the uncompressed `mimetype` entry.
- `epub-opf` parses in CrossInk `ContentOpfParser` and yields title, author and cover.
- `epub-xml` is well-formed under expat (`xml-check`).
- `epub-images` are baseline JPEGs with width <= 528 and height <= 792.

## How to get to it (user POV)

- From a shelf page, choose an article. CrossInk follows the acquisition link `rel="http://opds-spec.org/acquisition/open-access"` to `/opds/books/<id>.epub`.
- Fixture ids are `<shelf>-001` through `<shelf>-051`. The first Inbox book is `/opds/books/inbox-001.epub`.

## Driving it with opds-cli

Preconditions:

- `./scripts/opds-cli doctor` exits 0.
- A shelf walk or `fetch /opds/shortlist` has already produced a `BOOK` href. Do not invent an id that is not in the feed.
- Host tools for `walk` are present.

- **Follow a book link.** Run `./scripts/opds-cli walk --shelf shortlist --feature epub-acquisition`. The walk downloads the first page-2 `BOOK` href after paging checks.
- **Targeted download.** `./scripts/opds-cli fetch /opds/books/shortlist-001.epub --out .cache/verify-opds/evidence/<run>/shortlist-001.epub` writes the bytes. Status `200`, `Content-Type` is `application/epub+zip`, `Content-Length` matches the body, and `Content-Disposition` is `attachment; filename="<id>.epub"` (ASCII, no raw title).
- **Zip shape.** Bytes 30-38 of the file are `mimetype`.
- **Device parsers.** `walk` runs `xml-check` on every `.xhtml`/`.opf`/`.ncx`/`.xml` and `opf-check-crossink` on `OEBPS/content.opf`. Both must exit 0. OPF output includes a non-empty `title:` and a `cover:` path.
- **X3 images.** `images.json` lists every `.jpg`. Each row has `format=jpeg`, `progressive=false`, `width<=528`, `height<=792`. A progressive JPEG or a pixel edge above the panel is a failure.
- **Proof.** The evidence directory contains `book.epub`, `OEBPS/content.opf`, `opf-check.txt` and `images.json`, and `walk.json` reports those steps as PASS. A 200 without OPF and image checks is not proof.

## Gotchas

- Images that fail to fetch or decode are omitted from the EPUB. The fixture cover URL is `https://cdn.example/cover.png` and must be present as `OEBPS/images/cover.jpg`. A missing cover here is a bug, not an allowed skip.
- CrossInk names the SD file from the feed title via `StringUtils::sanitizeFilename` (150 bytes, FAT32-illegal chars become `_`). It does not read `Content-Disposition`. The server still sends a short ASCII `filename=` so SecureHttpClient's 4096-byte header line cap cannot trip.
- `walk` and `verify:crossink` run the CrossInk HTTP contract (Content-Length, safe disposition, 60s timeout, `META-INF/container.xml`). `npm run verify:crossink-limits` is the before/after probe (legacy chunked+title CD must fail; the fixed app must pass).
- CrossInk title truncation on the feed does not change the OPF title, which comes from the article document. Compare OPF `title:` to the document, not to the truncated `BOOK` line.
- `walk --all` also builds CrossPoint parsers and compares OPF fields. A CrossPoint build failure is printed; it does not excuse a CrossInk OPF failure.
- Unknown ids and unreadable categories (PDF, video) are `404`. That is not this feature; do not swap in a 404 and call acquisition verified.
