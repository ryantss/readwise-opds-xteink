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

A second `launch` against the same state file is refused while that pid is alive. Do not drive a catalog this run did not start. Do not drive `http://localhost:8787` (the token-backed `npm run dev` port) unless a human explicitly asked for a live token server, or you are running `npm run sim:x3` (that command owns 8787 and defaults to the fixture).

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
npm run verify:crossink-device
npm run sim:x3
```

`npm run verify:crossink-device` compiles CrossInk v1.6.1's own `HttpDownloader`, `SecureHttpClient`, `OpdsParser`, `StringUtils`, and `ZipFile` against a host FatFs image and wolfSSL 5.7.2. It fetches root → Inbox → one EPUB the way the X3 does (same UA, headers, 60s/30s timeouts, 2048-byte buffers, `sanitizeFilename` dest path, `.part` publish, `META-INF/container.xml` check) and prints CrossInk's English error strings (`Failed to fetch feed`, `Download failed`, `Insufficient SD card space`) on the failing step.

Credentials: username `ryan` and `OPDS_PASSWORD` against `https://rwopds.vercel.app/opds` when that env is set; otherwise the local fixture catalog. It cannot model ESP32 heap/fragmentation, WiFi timing, or a real SD card.

## X3 simulator (`npm run sim:x3`)

This is the headless Linux stand-in for CrossInk's official `env:simulator-X3` binary (PlatformIO native + SDL2, pin `v1.6.1` / `9914146eeae7b46b300f475a16c32426fc02ec1f`). It is not QEMU. v1.6.1's own docs say the simulator is Apple Silicon only; the sources compile on Linux after a local overlay. The overlay drops Clang's `-Wno-c++11-narrowing` with `build_unflags`, adds GCC's `-Wno-narrowing`, pins `uxjulia/crossink-simulator` to `27655f1d36ef5f8610fedd798d5564d04c8f4320`, and removes the `#ifdef SIMULATOR` fake catalog/download so the UI calls `HttpDownloader`.

The UI simulator cannot reproduce issue #7. That binary is compiled with `-DSIMULATOR` and without `FREEINK_NET_WOLFSSL`. `HttpDownloader` then uses the host `curl` shim: `contentLength` is the buffered body size, so a short body cannot fail the device Content-Length check, and the SD free-space check is compiled out. The wolfSSL + FatFs download proof is `crossink-device-harness`, not the SDL walk. Do not treat a green `sim:x3` UI as evidence that a production EPUB that dies at ~95% would succeed on the X3.

### Launch the catalog

Default (no Readwise token; what agents should use):

```sh
npm run sim:x3
```

That starts `startFixtureCatalog()` on `127.0.0.1:8787` with `OPDS_USERNAME=ryan` and password `x3-sim-test` (override with `OPDS_PASSWORD` / `SIM_X3_PASSWORD`). Same routes as `scripts/dev-server.js`, fixture-backed so no `READWISE_TOKEN` is required. This is the one case the rest of this skill allows on port 8787.

If `READWISE_TOKEN` is set, `sim:x3` starts `node scripts/dev-server.js 8787` instead and uses that live token. Do not do that for the fixture recipes above.

Host packages: PlatformIO **6.2.0** (the build script pins `pip install --user platformio==6.2.0`), `libsdl2-dev`, `libssl-dev`, `libexpat1-dev`, `curl`, `ffmpeg` (BMP to PNG), `xvfb` for screenshots, and `autoconf`/`automake`/`libtool` for the wolfSSL step of `build-crossink-device.sh`. First build fetches CrossInk + `freeink-sdk` into `.cache/crossink/`. `libcrypto` is linked for the simulator MD5 builder, not because the HTTP shim uses OpenSSL.

### What the walk does

1. Resets the CrossInk cache to the pin (`git reset --hard` + `clean`) and verifies the overlay (stubs gone, X3 flags present).
2. Seeds `/.crosspoint/opds.json` on an isolated `CROSSPOINT_SIM_SD` with the catalog URL, `ryan`, and the test password (plaintext `password` is accepted and re-obfuscated on load).
3. Boots `.pio/build/simulator-X3/program` under Xvfb.
4. Waits on log events (`Entering activity: …`, `Downloading screen presented`) then injects keys and screenshots through `CROSSINK_SIM_CONTROL`. A wall-clock schedule is not the pass condition. `04-download` is captured while the overlay is presenting the Downloading frame, before the blocking curl fetch.
5. Asserts seven distinct PNGs, exact `FileBrowser` / `EpubReader` lines, a non-empty zip with `META-INF/container.xml`, and a harness log that contains `PASS step=download` and `ALL PASS`.
6. Runs `crossink-device-harness --url http://127.0.0.1:8787/opds --shelf Inbox`. That step is the download proof.

Evidence: `.cache/crossink-sim/evidence/<run-id>/` (`meta.json`, `sim-x3.log`, `simulator.log`, `device-harness.log`, `screens/*.png`). A copy is also written to `/opt/cursor/artifacts/sim-x3/` and `/opt/cursor/artifacts/sim-x3-<run-id>/`.

### Missing vs a physical X3

- ESP32 heap / fragmentation
- wolfSSL record buffers, Content-Length completeness, and the free-space check inside the SDL process (see issue #7 note above)
- Real e-ink refresh
- Wi-Fi association (the pin skips Wi-Fi in the simulator and fetches immediately)
- The fixture inline JPEG often logs `Failed to open JPEG (err=4)` and leaves an empty rectangle on the reader page. Article text still opens. That is a documented simulator decoder miss, not a failed walk.

QEMU for ESP32-C3 is not used. The official native simulator is the X3 UI.

`walk --all` and `npm run verify:crossink` are the same PR #3 harness (`scripts/verify-crossink.js`). Prefer the CLI when you already launched an instance, so doctor and cleanup stay in one place.
