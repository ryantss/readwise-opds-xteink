import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const apply = join(here, "../scripts/crossink-sim/apply-overlays.py");
const applyControl = join(here, "../scripts/crossink-sim/apply-sim-control.py");

const FAKE_FEED = `#ifdef SIMULATOR
  clearEntries();
  searchTemplate = "simulator://search?query={searchTerms}";

  if (path.empty()) {
    appendEntry(OpdsEntry{OpdsEntryType::NAVIGATION, "Browse fiction", "", "/fiction", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "The Left Hand of Darkness", "Ursula K. Le Guin",
                          "/books/the-left-hand-of-darkness.epub", ""});
    appendEntry(
        OpdsEntry{OpdsEntryType::BOOK, "A Room of One's Own", "Virginia Woolf", "/books/a-room-of-ones-own.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "Frankenstein", "Mary Shelley", "/books/frankenstein.epub", ""});
  } else {
    appendEntry(
        OpdsEntry{OpdsEntryType::BOOK, "The Dispossessed", "Ursula K. Le Guin", "/books/the-dispossessed.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "Kindred", "Octavia E. Butler", "/books/kindred.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "The Time Machine", "H. G. Wells", "/books/the-time-machine.epub", ""});
  }

  selectorIndex = 0;
  topIndex = 0;
  state = BrowserState::BROWSING;
  requestUpdate();
  return;
#endif
`;

const FAKE_DOWNLOAD = `#ifdef SIMULATOR
  downloadProgress = 1;
  downloadTotal = 2;
  requestUpdate(true);
  return;
#endif
`;

function seedTree(iniExtra = "") {
  const root = mkdtempSync(join(tmpdir(), "overlay-"));
  mkdirSync(join(root, "src/activities/browser"), { recursive: true });
  writeFileSync(
    join(root, "src/activities/browser/OpdsBookBrowserActivity.cpp"),
    `void fetch() {\n${FAKE_FEED}\nreal_fetch();\n}\nvoid download() {\n${FAKE_DOWNLOAD}\nHttpDownloader::downloadToFile();\n}\n`
  );
  if (iniExtra) writeFileSync(join(root, "platformio.local.ini"), iniExtra);
  return root;
}

test("apply-overlays removes stubs, unflags clang, pins the simulator, and keeps user ini keys", () => {
  const root = seedTree("[env:simulator-X3]\nupload_port = /dev/ttyUSER\nbuild_flags =\n  -DDO_NOT_CLOBBER=1\n");
  execFileSync("python3", [apply, root], { encoding: "utf8" });
  const cpp = readFileSync(join(root, "src/activities/browser/OpdsBookBrowserActivity.cpp"), "utf8");
  const ini = readFileSync(join(root, "platformio.local.ini"), "utf8");
  assert.doesNotMatch(cpp, /Browse fiction/);
  assert.doesNotMatch(cpp, /downloadProgress = 1/);
  assert.match(cpp, /CROSSINK_SIM_LIVE_OPDS/);
  assert.match(cpp, /Downloading screen presented/);
  assert.match(cpp, /crossinkSimWaitControlShot/);
  assert.match(ini, /upload_port = \/dev\/ttyUSER/);
  assert.match(ini, /-DDO_NOT_CLOBBER=1/);
  assert.match(ini, /build_unflags = -Wno-c\+\+11-narrowing/);
  assert.match(ini, /27655f1d36ef5f8610fedd798d5564d04c8f4320/);
  assert.match(ini, /-DSIMULATOR_DEVICE_X3/);
});

test("apply-overlays fails when a return is put back under the live-OPDS marker", () => {
  const root = seedTree();
  execFileSync("python3", [apply, root], { encoding: "utf8" });
  const opds = join(root, "src/activities/browser/OpdsBookBrowserActivity.cpp");
  writeFileSync(
    opds,
    readFileSync(opds, "utf8").replace(
      "// CROSSINK_SIM_LIVE_OPDS: fall through to HttpDownloader::downloadToFile.",
      "// CROSSINK_SIM_LIVE_OPDS: fall through to HttpDownloader::downloadToFile.\n  return;"
    )
  );
  assert.throws(
    () => execFileSync("python3", [apply, root], { encoding: "utf8" }),
    /still returns before HttpDownloader/
  );
});

test("apply-sim-control injects wait-for-shot on a fresh HAL", () => {
  const root = mkdtempSync(join(tmpdir(), "simctl-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/HalGPIO.cpp"),
    "#include <cstdlib>\nvoid processSyntheticEvents() {\n  initializeSyntheticEvents();\n}\n"
  );
  writeFileSync(
    join(root, "src/HalDisplay.cpp"),
    "#include <cstdlib>\nvoid captureDueScreenshots() {\n  const unsigned long now = millis();\n}\nvoid HalDisplay::presentIfNeeded() {\n  const bool screenshotDue = hasDueScreenshot();\n}\n"
  );
  execFileSync("python3", [applyControl, root], { encoding: "utf8" });
  const display = readFileSync(join(root, "src/HalDisplay.cpp"), "utf8");
  assert.match(display, /hasControlShot/);
  assert.match(display, /crossinkSimWaitControlShot/);
  assert.match(display, /pollControlShot/);
});
