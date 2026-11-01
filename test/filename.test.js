import assert from "node:assert/strict";
import test from "node:test";

import { deviceFilenameFor } from "../scripts/crossink-http-probe.js";
import {
  contentDisposition,
  CROSSINK_MAX_FILENAME_BYTES,
  epubFilename,
  isSafeAsciiFilename,
  sanitizeCrossInkFilename
} from "../src/core/filename.js";

test("epubFilename is short ASCII and filesystem-safe", () => {
  assert.equal(epubFilename("doc1"), "doc1.epub");
  assert.equal(epubFilename("01m3vq8q9h6xnahpdczss343ne"), "01m3vq8q9h6xnahpdczss343ne.epub");
  assert.equal(epubFilename('Why $FOO failed: “evals” — a report'), "Why-FOO-failed-evals-a-report.epub");
  assert.equal(epubFilename(""), "untitled.epub");
  assert.ok(isSafeAsciiFilename(epubFilename("a:b/c*d")));
  assert.ok(contentDisposition(epubFilename("doc1")).length < 80);
});

test("contentDisposition does not echo the raw title", () => {
  assert.equal(contentDisposition("doc1.epub"), 'attachment; filename="doc1.epub"');
  assert.doesNotMatch(contentDisposition("doc1.epub"), /filename\*=/);
});

test("sanitizeCrossInkFilename matches v1.6.1 FAT32 rules", () => {
  assert.equal(sanitizeCrossInkFilename('Why $FOO failed: “evals” — a report'), "Why $FOO failed_ “evals” — a report");
  assert.equal(sanitizeCrossInkFilename("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitizeCrossInkFilename("   ..."), "book");
  const long = "x".repeat(300);
  assert.equal(sanitizeCrossInkFilename(long).length, CROSSINK_MAX_FILENAME_BYTES);
});

test("X3 SD names for the two production EPUBs in issue #7", () => {
  assert.equal(
    deviceFilenameFor({ title: "The State of Context Engineering", author: "Drew Breunig" }),
    "Drew Breunig - The State of Context Engineering.epub"
  );
  assert.equal(
    deviceFilenameFor({
      title: "How to build a Second Brain that actually does the work (Grok Bot full course)",
      author: "Argona"
    }),
    "Argona - How to build a Second Brain that actually does the work (Grok Bot full course).epub"
  );
});

test("example Inbox titles keep Unicode and replace only FAT32-illegal punctuation", () => {
  assert.equal(
    deviceFilenameFor({ title: 'Why $FOO failed: “evals” — a report', author: "Émile Zola" }),
    "Émile Zola - Why $FOO failed_ “evals” — a report.epub"
  );
  assert.equal(
    deviceFilenameFor({ title: "Failed to fetch feed: why?", author: "Hamel Husain" }),
    "Hamel Husain - Failed to fetch feed_ why_.epub"
  );
});
