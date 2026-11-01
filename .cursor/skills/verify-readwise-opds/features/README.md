# Readwise OPDS verification map

This directory is the maintained source for verifying the user-facing behavior of the Readwise OPDS catalog. Read this index before driving the app, then use the matching feature file as the recipe.

The catalog is consumed by CrossInk's OPDS browser on an Xteink X3 (and by CrossPoint). There is no first-party web UI. Proof is HTTP plus the CrossInk parser binaries from `scripts/build-crossink-checks.sh`.

`/maintain-verification-skill` keeps this map honest as routes and parser pins change.

## Baseline preconditions

- Launch the mocked catalog with `./scripts/opds-cli launch` from the repo root.
- Require `./scripts/opds-cli doctor` to exit 0 before the first drive.
- Use fixture credentials `fixture-reader` / `fixture-password`. They live in `scripts/fixture-catalog.js` as `FIXTURE_USERNAME` and `FIXTURE_PASSWORD`.
- Default origin is `http://127.0.0.1:8788`. Read the live origin from `.cache/verify-opds/instance.json` if `--port` was not the default.
- Put evidence under `.cache/verify-opds/evidence/<run-id>/`. Never delete that tree during cleanup.
- Never drive a catalog this run did not start. Never drive `scripts/dev-server.js` (real Readwise token) for these recipes.
- `clang++` or `g++` and the Expat headers (`expat.h` / `libexpat1-dev`) must be present before `walk`.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat route paths as the stable handles: `/opds`, `/opds/inbox`, `/opds/shortlist`, `/opds/later`, `/opds/archive`, `/opds/books/<id>.epub`.
- Run catalog actions through `./scripts/opds-cli`.
- Follow `rel="next"` (or CrossInk's `next page:` line). Do not invent cursors.
- Restore nothing after a drive: the fixture is read-only and in-memory.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the request and the resulting feed or EPUB, not only the final status code.
- Feed proof includes the Atom body and CrossInk `opds-check-crossink` output.
- EPUB proof includes the file on disk, OPF fields from `opf-check-crossink`, and JPEG metadata.
- Auth proof includes the status and the `WWW-Authenticate` header.
- Record the feature ID and entry point used with every artifact (`walk --feature <id>`).
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- Never weaken a journey to make it pass. If the fixture or parser disagrees with the map, report the failure.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with opds-cli` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Authenticated root menu](./authenticated-root-menu.md) covers opening the catalog with Basic auth and listing Inbox, Shortlist, Later and Archive.
- [Shelf feeds and paging](./shelf-feeds-and-paging.md) covers a shelf of 10 articles, next/previous links, and CrossInk's 50-entry cap.
- [EPUB acquisition](./epub-acquisition.md) covers downloading an article as an EPUB with X3-sized baseline JPEGs. Use `npm run verify:crossink-device` when proving the firmware download path itself (HTTP + parser + FatFs + container.xml), not only the catalog bytes.
- [X3 simulator](./x3-simulator.md) covers the headless CrossInk `simulator-X3` walk (`npm run sim:x3`): Home → catalog → Inbox → download → open, with screenshots.
- [Auth rejection](./auth-rejection.md) covers requests without credentials and with the wrong password.
