# X3 simulator

A headless Linux run of CrossInk v1.6.1's official `env:simulator-X3` binary drives the real X3 UI against a local catalog on port 8787: Home, OPDS Browser, Inbox, download, then open.

## Sub-features

- `sim-boot` starts the pinned `simulator-X3` program under Xvfb.
- `sim-catalog` opens the seeded Readwise OPDS server and lists Inbox, Shortlist, Later and Archive.
- `sim-inbox` opens Inbox and shows fixture (or live) article rows.
- `sim-download` downloads the first Inbox book onto the simulated SD card.
- `sim-open` opens that EPUB in the firmware reader.
- `sim-harness` still runs `npm run verify:crossink-device`'s binary against the same catalog (wolfSSL + FatFs).

## How to get to it (user POV)

- Home → OPDS Browser (shown once `/.crosspoint/opds.json` has a server).
- Catalog root → Inbox → article → Download.
- Back to Home → Browse Files → the new `.epub`.

## Driving it with opds-cli

Preconditions:

- `pio`, `sdl2-config`, OpenSSL headers, Expat headers, `curl`, `ffmpeg`, `xvfb-run`, and `autoconf`/`automake`/`libtool` (wolfSSL) are on the host.
- No other process is bound to `127.0.0.1:8787` unless you pass `SIM_X3_PORT`.

- **Default agent walk.** `npm run sim:x3` starts the fixture catalog on `http://127.0.0.1:8787/opds` as `ryan` / `x3-sim-test`, builds the simulator, seeds the SD card, injects keys, writes screenshots, then runs `crossink-device-harness`.
- **Live token server.** `READWISE_TOKEN=... OPDS_PASSWORD=... npm run sim:x3` starts `scripts/dev-server.js` on 8787 instead. Do not use that for the other fixture recipes in this skill.
- **Proof.** `.cache/crossink-sim/evidence/<run-id>/screens/` has `01-home.png` through `07-reader.png`, `simulator.log` shows the input schedule, and `device-harness.log` ends with `ALL PASS`. A home screenshot without Inbox/download/open is not this feature.

## Gotchas

- CrossInk v1.6.1 stubs OPDS under `#ifdef SIMULATOR`. `scripts/crossink-sim/apply-overlays.py` is a local checkout overlay; it is not pushed to uxjulia/CrossInk.
- One seeded server skips the OPDS server picker (`ActivityManager::goToBrowser`).
- The SDL process uses host `curl`, not wolfSSL. The harness step is the wolfSSL proof. Do not delete it.
- Screenshot times are measured from process start. A slow first EPUB build can miss `04-download`; raise the schedule in `scripts/sim-x3.js` rather than clicking by hand. A fast fixture download can also leave `04-download.png` on the Inbox list (progress is a single blocking paint). The SD `.epub` plus `06-files` / `07-reader` are the download proof.
- QEMU is not part of this path.
