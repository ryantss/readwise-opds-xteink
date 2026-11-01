import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync } from "fflate";

import {
  assertActivities,
  assertDistinctScreens,
  assertHarnessDownloaded,
  assertValidEpub,
  enteredActivity
} from "../scripts/crossink-sim/walk-gates.js";

test("enteredActivity does not treat FileBrowserSettings as FileBrowser", () => {
  const log = "[0] [DBG] [ACT] Entering activity: FileBrowserSettings\n";
  assert.equal(enteredActivity(log, "FileBrowser"), false);
  assert.equal(enteredActivity(log, "FileBrowserSettings"), true);
  assert.equal(enteredActivity("[0] [DBG] [ACT] Entering activity: FileBrowser\n", "FileBrowser"), true);
});

test("assertActivities requires EpubReader and a real FileBrowser", () => {
  assert.throws(
    () =>
      assertActivities(
        "Entering activity: FileBrowserSettings\nEntering activity: Reader\nEntering activity: OpdsBookBrowser\n"
      ),
    /FileBrowser/
  );
  assert.throws(
    () =>
      assertActivities(
        "Entering activity: OpdsBookBrowser\nEntering activity: FileBrowser\nEntering activity: Reader\n"
      ),
    /EpubReader/
  );
  assert.throws(
    () =>
      assertActivities(
        "Entering activity: OpdsBookBrowser\nEntering activity: FileBrowser\nEntering activity: Reader\nEntering activity: EpubReader\n"
      ),
    /Downloading screen/
  );
  assertActivities(
    "Entering activity: OpdsBookBrowser\nEntering activity: FileBrowser\nEntering activity: Reader\nEntering activity: EpubReader\nDownloading screen presented\n"
  );
});

test("assertDistinctScreens rejects identical bitmaps", () => {
  const same = Buffer.alloc(64, 7);
  assert.throws(
    () => assertDistinctScreens({ "03-inbox": same, "04-download": Buffer.from(same) }),
    /identical/
  );
  const hashes = assertDistinctScreens({ a: Buffer.alloc(64, 1), b: Buffer.alloc(64, 2) });
  assert.notEqual(hashes.a, hashes.b);
});

test("assertValidEpub rejects a 0-byte or non-zip file named .epub", () => {
  const dir = mkdtempSync(join(tmpdir(), "epub-gate-"));
  const empty = join(dir, "planted.epub");
  writeFileSync(empty, "");
  assert.throws(() => assertValidEpub(empty), /too small/);
  const fake = join(dir, "not-an-epub.epub");
  writeFileSync(fake, "not-an-epub-padded-so-the-size-gate-is-not-the-reason");
  assert.throws(() => assertValidEpub(fake), /not a zip/);
});

test("assertValidEpub accepts a zip with container.xml", () => {
  const dir = mkdtempSync(join(tmpdir(), "epub-ok-"));
  const file = join(dir, "book.epub");
  const bytes = zipSync({
    mimetype: new TextEncoder().encode("application/epub+zip"),
    "META-INF/container.xml": new TextEncoder().encode("<container />")
  });
  writeFileSync(file, bytes);
  const info = assertValidEpub(file);
  assert.ok(info.size > 100 || info.files >= 2);
});

test("assertHarnessDownloaded requires the download steps, not just exit 0", () => {
  assert.throws(() => assertHarnessDownloaded("HARNESS_EXIT_WITHOUT_DOWNLOAD\n"), /did not download|ALL PASS/);
  assert.throws(() => assertHarnessDownloaded("ALL PASS\n"), /did not download/);
  assertHarnessDownloaded(
    "PASS step=download /book.epub\nPASS step=validate META-INF/container.xml\nALL PASS /book.epub 3247 bytes\n"
  );
});
