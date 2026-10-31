# Authenticated root menu

The catalog root is the OPDS navigation feed the X3 shows after the reader opens this server: the title Readwise, and four shelves (Inbox, Shortlist, Later, Archive) that each open an acquisition feed.

## Sub-features

- `root-auth` accepts fixture Basic credentials on `GET /opds`.
- `root-navigation` returns an OPDS navigation document, not an article list.
- `root-shelves` lists Inbox, Shortlist, Later and Archive in that order, each with a subsection link.
- `root-crossink` parses as four `NAV` entries in CrossInk `OpdsParser`.

## How to get to it (user POV)

- On the X3: Home -> OPDS Browser -> the Readwise server. CrossInk requests `GET /opds` with the stored username and password.
- From a computer: `GET /opds` with the same Basic credentials.

## Driving it with opds-cli

Preconditions:

- `./scripts/opds-cli doctor` exits 0.
- Origin is the launched fixture (default `http://127.0.0.1:8788`).

- **Open catalog.** Fetch the root. Run `./scripts/opds-cli fetch /opds --out .cache/verify-opds/evidence/root-menu/root.xml`. Exit code `0`, status `200`, `Content-Type` contains `profile=opds-catalog;kind=navigation`, and `Content-Length` matches the body.
- **Read shelves.** The Atom body has `<title>Readwise</title>` and exactly four entries titled `Inbox`, `Shortlist`, `Later` and `Archive`, with `rel="subsection"` hrefs `/opds/inbox`, `/opds/shortlist`, `/opds/later` and `/opds/archive`.
- **CrossInk view.** Run `./scripts/opds-cli walk --shelf inbox --feature authenticated-root-menu` or parse the saved XML with `opds-check-crossink`. CrossInk prints `NAV Inbox`, `NAV Shortlist`, `NAV Later`, `NAV Archive` and `truncated: no`.
- **Proof.** `root.xml` plus `root.opds.txt` (or the walk evidence directory) show the four shelf titles in order. Status `200` without those titles is not proof.

## Gotchas

- `/opds` does not call Readwise. A 200 here does not prove a shelf or an EPUB works.
- CrossInk prints `NAV` for shelves and `BOOK` for articles. Do not treat a `NAV` line as a downloadable EPUB.
- The token-backed `npm run dev` server on port 8787 is a different process. Doctor will reject it.
