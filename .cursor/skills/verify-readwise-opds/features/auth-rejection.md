# Auth rejection

Every catalog route requires HTTP Basic credentials. A request with no header, or with the wrong password, is rejected before any feed or EPUB is built. The X3 only sends Basic auth when both username and password are stored for the server.

## Sub-features

- `auth-missing` rejects `GET /opds` without an `Authorization` header.
- `auth-wrong` rejects fixture username plus a wrong password.
- `auth-challenge` sends `WWW-Authenticate: Basic realm="Readwise OPDS"`.
- `auth-books` rejects an EPUB path the same way, so a leaked book URL is not open-access.

## How to get to it (user POV)

- Add the server on the X3 with a blank password, or with the wrong password. CrossInk still `GET`s `/opds` and shows a fetch failure.
- From a computer: `GET /opds` or `GET /opds/books/shortlist-001.epub` with no auth, or with `fixture-reader` and a bad password.

## Driving it with opds-cli

Preconditions:

- `./scripts/opds-cli doctor` exits 0 (the positive-auth half of doctor has already passed).
- Do not stop the catalog. Rejection is checked against the same instance.

- **Missing header.** Run `./scripts/opds-cli fetch /opds --no-auth --expect-status 401 --out .cache/verify-opds/evidence/auth-rejection/root-unauth.txt`. Exit code `0`, status `401`, `WWW-Authenticate` matches `Basic realm="Readwise OPDS"`.
- **Wrong password.** Run `./scripts/opds-cli fetch /opds --user fixture-reader --password nope --expect-status 401`. Status `401` with the same realm.
- **Book path.** Run `./scripts/opds-cli fetch /opds/books/shortlist-001.epub --no-auth --expect-status 401`. Status `401`. A 200 here is a failure: acquisition links are not anonymous.
- **Proof.** Save the CLI `--json` objects (status, `wwwAuthenticate`) next to the bodies. The observable end state is 401 plus the Basic realm on `/opds` and on an EPUB path. A 401 on `/opds` alone does not prove books are protected.

## Gotchas

- `--expect-status 401` makes a 401 exit 0. Without that flag, `fetch` treats 401 as failure (exit 1), which is easy to misread as a broken catalog.
- Doctor already checks missing-auth on `/opds`. Still drive the wrong-password and EPUB paths; doctor does not cover them.
- An empty username or password on the server side fails closed (every request 401). The fixture always has both set. If launch forgets credentials, doctor fails first.
