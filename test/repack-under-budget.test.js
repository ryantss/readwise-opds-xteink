import assert from "node:assert/strict";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import sharp from "sharp";

import { imgAltTexts, repackUnderBudget, visibleText } from "../scripts/repack-under-budget.js";

const jpeg = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 40, b: 60 } }
})
  .jpeg()
  .toBuffer();

test("repack uses the cover basename, parses every quote style, and skips one bad jpeg", async () => {
  const chapter = [
    "<p>Keep this sentence.</p>",
    `<img src='images/photo.jpg' alt='single quoted'/>`,
    `<img src="images/discover.jpg" alt="discover view"/>`,
    `<img alt="broken shot" src="images/bad.jpg"/>`,
    "<img src=images/plain.jpg alt=plain>"
  ].join("");
  const input = zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8("<container/>"),
    "OEBPS/chapter.xhtml": strToU8(chapter),
    "OEBPS/images/cover.jpg": [jpeg, { level: 0 }],
    "OEBPS/images/discover.jpg": [jpeg, { level: 0 }],
    "OEBPS/images/photo.jpg": [jpeg, { level: 0 }],
    "OEBPS/images/plain.jpg": [jpeg, { level: 0 }],
    "OEBPS/images/bad.jpg": [Buffer.from("this is not a jpeg"), { level: 0 }]
  });

  const out = await repackUnderBudget(input, { id: "t", title: "T", author: "A" });
  const entries = unzipSync(out);
  const opf = strFromU8(entries["OEBPS/content.opf"]);
  const chapterOut = strFromU8(entries["OEBPS/chapter.xhtml"]);

  assert.match(opf, /href="images\/cover.jpg"/);
  assert.match(opf, /id="cover-image"/);
  assert.doesNotMatch(opf, /cover-image" href="images\/discover.jpg"/);
  assert.match(opf, /href="images\/discover.jpg"/);
  assert.equal(entries["OEBPS/images/bad.jpg"], undefined);
  assert.match(chapterOut, /<i>broken shot<\/i>/);
  assert.match(chapterOut, /images\/photo.jpg/);
  assert.match(chapterOut, /images\/plain.jpg/);
  assert.equal(visibleText(chapterOut), visibleText(chapter));
  assert.deepEqual(imgAltTexts(chapter).sort(), ["broken shot", "discover view", "plain", "single quoted"]);
});
