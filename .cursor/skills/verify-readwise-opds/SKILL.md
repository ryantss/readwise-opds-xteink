---
name: verify-readwise-opds
description: "Drive the Readwise OPDS catalog (Atom feeds and EPUB downloads) the way CrossInk on an Xteink X3 would. Use when proving /opds behavior, shelf paging, HTTP Basic auth, or EPUB acquisition against the mocked Readwise fixture."
---

# Verify Readwise OPDS

This skill drives [readwise-opds-xteink](https://github.com/chuyeow/readwise-opds-xteink) the way CrossInk's OPDS browser on an Xteink X3 does: HTTP Basic auth, Atom navigation and acquisition feeds, then an EPUB download. The user-facing surface is HTTP, not a web UI.

Read the feature map under [features/](features/README.md) before a proof. Drive the mapped user path. Do not substitute unit tests or a live Readwise account.

The only allowed Readwise stand-in is `scripts/fixture-catalog.js`. Do not export a real `READWISE_TOKEN`. Do not start `scripts/dev-server.js` for this skill: that process talks to the real Readwise API.

`/maintain-verification-skill` is the upkeep loop for this map as the catalog changes.

## Launch

From the repo root, with no live instance at the default state file (or only a stale pid):

```sh
npm install
./scripts/opds-cli launch
```

Equivalent: `npm run opds -- launch`.

What that starts: a detached `opds-cli.js serve` that calls `startFixtureCatalog()` from `scripts/fixture-catalog.js`. The catalog is in-memory. Credentials are `fixture-reader` / `fixture-password`. Default bind is `127.0.0.1:8788`. State is written to `.cache/verify-opds/instance.json`. Server stdout/stderr append to `.cache/verify-opds/server.log`.

Ready means all of these, not merely that a port accepts TCP:

- stdout ends with `ready http://127.0.0.1:8788/opds` (JSON: `"ready": true`, `"baseUrl": "http://127.0.0.1:8788"`)
- `./scripts/opds-cli doctor` exits 0

`walk` also needs `clang++` or `g++` and the Expat C headers (`expat.h`, Debian/Ubuntu package `libexpat1-dev`), the same host tools as `npm run verify:crossink`. Launch itself does not compile parsers. A runtime `libexpat.so` without headers is not enough: `build-crossink-checks.sh` will fail with `fatal error: expat.h: No such file or directory`.

Node: `package.json` engines is `>=24`. The fixture catalog also runs on Node 22. An `EBADENGINE` warning from `npm install` is not a launch failure.

Teardown:

```sh
./scripts/opds-cli stop
```

Two catalogs can run side by side (in-memory data, bind address is localhost). Use a second port and state file:

```sh
./scripts/opds-cli --state .cache/verify-opds/instance-b.json launch --port 8789
```

A second `launch` against the same state file is refused while that pid is alive. Do not drive a catalog this run did not start. Do not drive `http://localhost:8787` (the token-backed `npm run dev` port) unless a human explicitly asked for a live token server.

## Doctor

```sh
./scripts/opds-cli doctor
```

One read-only check. Run it before the first drive, after any failed drive, and whenever the instance looks off. Pass means every line below is true:

- **process:** the pid in `.cache/verify-opds/instance.json` is alive
- **build:** that pid's cmdline is `opds-cli.js serve`, its cwd is this repo, `kind` is `readwise-opds-fixture`, and `GET /opds` (authenticated) is a Readwise navigation feed listing Inbox, Shortlist, Later and Archive
- **port:** `lsof` shows that pid LISTENs on the recorded `127.0.0.1` port
- **auth:** `GET /opds` without credentials is `401` with `WWW-Authenticate: Basic realm="Readwise OPDS"`; with fixture credentials it is `200`

Non-zero exit if any check fails. Do not drive a failing instance. Relaunch rather than hoping.

## Drive

Stable handles are route paths, not CSS or coordinates.

| User action on the X3 | Route | CLI |
| --- | --- | --- |
| Open the catalog (OPDS Browser) | `/opds` | `./scripts/opds-cli fetch /opds` |
| Open Inbox / Shortlist / Later / Archive | `/opds/inbox`, `/opds/shortlist`, `/opds/later`, `/opds/archive` | `./scripts/opds-cli fetch /opds/inbox` |
| Next page | `/opds/<shelf>?cursor=<cursor>` | Follow `rel="next"` from the feed, or the `next page:` line from CrossInk |
| Download an article | `/opds/books/<id>.epub` | `./scripts/opds-cli fetch /opds/books/shortlist-001.epub --out FILE` |
| Browse without credentials | `/opds` | `./scripts/opds-cli fetch /opds --no-auth --expect-status 401` |

The CrossInk user path (root -> one shelf -> next page -> EPUB), through the device parsers from PR #3:

```sh
./scripts/opds-cli walk --shelf shortlist --feature shelf-feeds-and-paging
```

`--shelf` is `inbox`, `shortlist`, `later`, or `archive`. `walk` builds `scripts/build-crossink-checks.sh` (CrossInk pin `v1.6.1`, `9914146eeae7b46b300f475a16c32426fc02ec1f`) and runs `opds-check-crossink`, `xml-check`, and `opf-check-crossink`.

The full PR #3 harness (every shelf, next page, one EPUB each, plus CrossPoint comparison when those binaries build):

```sh
./scripts/opds-cli walk --all
```

That runs `node scripts/verify-crossink.js <baseUrl> 1` with the fixture credentials. Do not reimplement that script.

Auth overrides for the rejection journey:

```sh
./scripts/opds-cli fetch /opds --no-auth --expect-status 401
./scripts/opds-cli fetch /opds --user fixture-reader --password nope --expect-status 401
```

`--json` is valid on every command. Unknown flags and missing instances exit 2 with a hint. Failed checks exit 1.

## Evidence

Named location (never deleted by cleanup):

```
.cache/verify-opds/evidence/<run-id>/
```

`<run-id>` is an UTC stamp plus the `--feature` id. `walk` always creates a directory there. `fetch --out` should write into that same tree when you are capturing a proof.

Proof standards:

- Exercise the HTTP path the X3 uses (`/opds`, a shelf, `rel="next"`, `/opds/books/<id>.epub`). Do not call `createApp` or the Readwise client from a test file and call that a proof.
- Capture the action and the resulting state: the request path, status, CrossInk parser output, and (for a download) OPF fields plus JPEG metadata. A 200 alone is not enough.
- Side effects to verify: EPUB bytes on disk, unzipped `OEBPS/content.opf`, baseline JPEGs within 528x792. This server stores nothing of its own.
- Mocks stay at the Readwise API boundary (`https://readwise.io/api/v3/list/` and `https://cdn.example/` inside `scripts/fixture-catalog.js`). The OPDS HTTP server and the CrossInk parsers are real.
- `stop --dry-run` is the only dry-run. It prints the pid and port and must not send a signal. Confirm afterwards with `doctor` that the pid is still alive. `walk` and `fetch` are not dry-runs; they hit the live fixture.

Minimum artifacts for a shelf walk:

- `meta.json` (feature id, base URL, CrossInk pin)
- `root.xml` and `root.opds.txt`
- `<shelf>-page1.xml`, `<shelf>-page1.opds.txt`, `<shelf>-page2.xml`, `<shelf>-page2.opds.txt`
- `<id>/book.epub`, `<id>/OEBPS/content.opf`, `<id>/opf-check.txt`, `<id>/images.json`
- `walk.json` (PASS/FAIL steps)

## Cleanup

```sh
./scripts/opds-cli stop --dry-run    # inspect only
./scripts/opds-cli stop              # SIGTERM the recorded pid; SIGKILL if it ignores
```

Kill only the pid in the state file this run wrote. Never `pkill -f opds` or kill by process name. `stop` removes `.cache/verify-opds/instance.json` and leaves `.cache/verify-opds/evidence/` and `server.log` alone.

After cleanup, confirm the evidence directory still exists (`ls .cache/verify-opds/evidence/<run-id>`). A cleanup that ate the proof fails the run.

If a launch or walk fails, run `stop` anyway so a broken pid does not hold the port.

## Helpers

`scripts/opds-cli` is executable. `scripts/opds-cli.js` is the implementation. Both are invoked from the repo root.

```sh
./scripts/opds-cli --help
./scripts/opds-cli launch --help
./scripts/opds-cli doctor --help
./scripts/opds-cli walk --help
./scripts/opds-cli fetch --help
./scripts/opds-cli stop --help
./scripts/opds-cli launch
./scripts/opds-cli doctor --json
./scripts/opds-cli walk --shelf shortlist --feature shelf-feeds-and-paging
./scripts/opds-cli fetch /opds --json
./scripts/opds-cli stop --dry-run
./scripts/opds-cli stop
npm run opds -- launch
npm run verify:crossink
npm run verify:crossink-limits
```

`walk --all` and `npm run verify:crossink` are the same PR #3 harness (`scripts/verify-crossink.js`). Prefer the CLI when you already launched an instance, so doctor and cleanup stay in one place.
