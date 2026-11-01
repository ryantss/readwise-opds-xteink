# X3 simulator

A headless Linux run of CrossInk v1.6.1's official `env:simulator-X3` binary drives the real X3 UI against a local catalog on port 8787: Home, OPDS Browser, Inbox, download, then open.

## Sub-features

- `sim-boot` starts the pinned `simulator-X3` program under Xvfb.
- `sim-catalog` opens the seeded Readwise OPDS server and lists Inbox, Shortlist, Later and Archive.
- `sim-inbox` opens Inbox and shows fixture (or live) article rows.
- `sim-download` downloads the first Inbox book onto the simulated SD card while the Downloading screen is showing.
- `sim-open` opens that EPUB in the firmware reader (`EpubReader`, not only `Reader`).
- `sim-harness` still runs `npm run verify:crossink-device`'s binary against the same catalog (wolfSSL + FatFs). That is the download proof.

## How to get to it (user POV)

- Home → OPDS Browser (shown once `/.crosspoint/opds.json` has a server).
- Catalog root → Inbox → article → Download.
- Back to Home → Browse Files → the new `.epub`.

## Driving it with opds-cli

Preconditions:

- PlatformIO 6.2.0, `sdl2-config`, OpenSSL headers, Expat headers, `curl`, `ffmpeg`, `xvfb-run`, and `autoconf`/`automake`/`libtool` (wolfSSL) are on the host.
- No other process is bound to `127.0.0.1:8787` unless you pass `SIM_X3_PORT`.

- **Default agent walk.** `npm run sim:x3` starts the fixture catalog on `http://127.0.0.1:8787/opds` as `ryan` / `x3-sim-test`, resets the CrossInk cache to the pin, builds the simulator, seeds the SD card, waits on log events, writes screenshots, then runs `crossink-device-harness`.
- **Live token server.** `READWISE_TOKEN=... OPDS_PASSWORD=... npm run sim:x3` starts `scripts/dev-server.js` on 8787 instead. Do not use that for the other fixture recipes in this skill.
- **Proof.** All of these, not a zero exit: `.cache/crossink-sim/evidence/<run-id>/screens/` has seven PNGs with different hashes; `04-download.png` is not a copy of `03-inbox.png`; `simulator.log` has exact `Entering activity: FileBrowser` and `Entering activity: EpubReader` lines; the SD `.epub` is a non-empty zip with `META-INF/container.xml`; `device-harness.log` contains `PASS step=download` and `ALL PASS`. A home screenshot without Inbox/download/open is not this feature.

## Gotchas

- CrossInk v1.6.1 stubs OPDS under `#ifdef SIMULATOR`. `scripts/crossink-sim/apply-overlays.py` is a local checkout overlay; it is not pushed to uxjulia/CrossInk. The build resets the cache (`git reset --hard` + clean) and verifies the stubs are gone. A leftover marker comment is not enough.
- One seeded server skips the OPDS server picker (`ActivityManager::goToBrowser`).
- The UI simulator cannot reproduce issue #7. It is compiled with `-DSIMULATOR` and without wolfSSL. The HTTP client is host `curl` (`popen`); `contentLength` is the buffered body size, so a short body cannot fail the device completeness check. The SD free-space check is compiled out. The harness step is the wolfSSL + FatFs proof. Do not delete it, and do not treat a green UI walk as a #7 fix.
- Keys and screenshots wait on log events (`Downloading screen presented`, activity names). The curl fetch blocks the SDL thread, so the overlay presents the Downloading frame and accepts `04-download` before `downloadToFile`. A wall-clock sleep after `Downloading:` is too late: that log is immediately before the blocking fetch, and the next present is the Inbox again.
- `FileBrowserSettings` is a different activity. The gate requires a line that ends with `FileBrowser`. `Reader` logs before `loadEpub`; a failed open never reaches `EpubReader`.
- The fixture inline JPEG often logs `[ERR] [JPG] Failed to open JPEG (err=4)` and leaves an empty rectangle under the article text in `07-reader.png`. That is a simulator decoder miss. The walk still counts if the page text is the fixture article.
- QEMU is not part of this path.
