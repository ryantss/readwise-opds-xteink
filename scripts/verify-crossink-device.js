#!/usr/bin/env node
// Drive CrossInk v1.6.1's own HTTP + OPDS + FatFs download path on the host.
// Preferred target is https://rwopds.vercel.app/opds with username ryan and
// OPDS_PASSWORD. When that env is unset, the fixture catalog is used instead.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strFromU8, unzipSync } from "fflate";

import { EPUB_BYTE_BUDGET, OBSERVED_BODY_BYTES, OBSERVED_TAIL_STOP, UNCAPPED_TEXT_EXAMPLE_BYTES } from "../src/core/budget.js";
import { buildEpub } from "../src/core/epub.js";
import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "./fixture-catalog.js";
import { startObservedTailServer } from "./observed-tail-server.js";
import { imgAltTexts, repackUnderBudget, visibleText } from "./repack-under-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PRODUCTION = "https://rwopds.vercel.app/opds";
const EXAMPLES = [
  { title: "The State of Context Engineering", author: "Drew Breunig" },
  { title: "How to build a Second Brain that actually does the work (Grok Bot full course)", author: "Argona" },
  { title: 'Why $FOO failed: “evals” — a report', author: "Émile Zola" },
  { title: "Failed to fetch feed: why?", author: "Hamel Husain" },
  {
    title:
      "A fixture title padded so CrossInk's 160-character OpdsParser cap can be compared against CrossPoint: " +
      "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    author: "Shortlist Author"
  }
];

const FAILING_EPUBS = [
  {
    file: "/tmp/failing-epubs/01m62s8vznfmgdxc37yevr5efq.epub",
    title: "The State of Context Engineering",
    author: "Drew Breunig"
  },
  {
    file: "/tmp/failing-epubs/01m5ad7pndwt54mkgwpg845shq.epub",
    title: "How to build a Second Brain that actually does the work (Grok Bot full course)",
    author: "Argona"
  }
];

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
}

function runHarness(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function jpgCount(entries) {
  return Object.keys(entries).filter((name) => name.toLowerCase().endsWith(".jpg")).length;
}

function altsKept(beforeXhtml, afterXhtml) {
  const before = imgAltTexts(beforeXhtml);
  const after = visibleText(afterXhtml);
  const kept = before.filter((alt) => after.includes(alt)).length;
  return { before: before.length, kept };
}

function textOnlyEpub(words) {
  const parts = new Array(words);
  for (let i = 0; i < words; i++) parts[i] = `w${i.toString(36)}`;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${parts.join(" ")}</p></body></html>`;
  return buildEpub({
    id: "text-only",
    title: "Text only article",
    author: "Example",
    language: "en",
    modified: "2020-01-01T00:00:00Z",
    chapter,
    images: [],
    cover: null
  });
}

function textOnlyAtLeast(target) {
  let lo = 2000;
  let hi = 500000;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bytes = textOnlyEpub(mid);
    if (bytes.length >= target) {
      best = bytes;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (!best || best.length < target) throw new Error(`text-only epub did not reach ${target} bytes`);
  return best;
}

const rows = [];

console.log("=== observed tail cut ===");
console.log(
  `Production sent Content-Length ${OBSERVED_BODY_BYTES} for The Rise of the Self-Driving Company. The bar stopped on the last 64KiB tick, ${OBSERVED_TAIL_STOP} bytes (${((100 * OBSERVED_TAIL_STOP) / OBSERVED_BODY_BYTES).toFixed(1)}%).`
);
console.log(
  "This host harness finishes a full body of that length with keep-alive, with a TLS close_notify, and with a TCP RST after the last byte. Cutting the stream at 458752 while still advertising 502491 makes wolfSSL return SOCKET_PEER_CLOSED_E (-397) and HttpDownloader log Incomplete before sync, ZipFile, or .part publish."
);
console.log(
  "v1.6.1 downloadBook never calls clearEntries(), so the parsed catalog stays allocated during the EPUB GET. A later note on CrossInk issue 836 says freeing that catalog before the GET let the same book finish."
);
console.log(
  `EPUB_BYTE_BUDGET is ${EPUB_BYTE_BUDGET} bytes. It only shortens the TLS read. It is a size workaround, not a proven fix for that allocation. Text-only articles are not capped. A ${UNCAPPED_TEXT_EXAMPLE_BYTES}-byte text EPUB still ships whole.`
);
console.log("");
console.log("=== 1 Nov video, primary article ===");
console.log("The Rise of the Self-Driving Company, Amjad Masad, id 01m6ayz163q7d673wrkq76hcn1");
console.log(`production GET twice, 200, Content-Length ${OBSERVED_BODY_BYTES}. The bytes were not saved here.`);
console.log("");
console.log("=== still cannot model ===");
console.log("- ESP32 heap fragmentation. A full 502491-byte body completes on this host");
console.log("- WiFi stalls (DOWNLOAD_IDLE_TIMEOUT_MS=30000). The video failed in a fraction of a second, so this was not a timeout");
console.log("- SdFat SPI write chunks versus this host FatFs image");
console.log("- whether the 100% frame was requested and then replaced before the panel showed it");
console.log("");

console.log("=== build ===");
const built = execFileSync(join(here, "build-crossink-device.sh"), [], { encoding: "utf8", cwd: root });
const harness = built.trim().split("\n").at(-1);
if (!existsSync(harness)) {
  console.error(`FAIL build: expected ${harness}`);
  process.exit(1);
}
console.log(built.trim());
console.log(`PASS build ${harness}`);

let failures = 0;

console.log("\n=== full body vs tail cut (wolfSSL + HttpDownloader) ===");
const tail = await startObservedTailServer();
try {
  const cases = [
    { name: "full-keepalive", expectOk: true, connection: "keep-alive" },
    { name: "full-close", expectOk: true, connection: "close" },
    { name: "full-rst", expectOk: true, connection: "keep-alive" },
    { name: "tail", expectOk: false }
  ];
  for (const item of cases) {
    console.log(`\n--- ${item.name} ---`);
    const result = await runHarness(harness, [
      "--download-url",
      `${tail.baseUrl}/${item.name}`,
      "--title",
      item.name,
      "--image",
      `/tmp/crossink-device-${item.name}.fat`
    ]);
    const combined = `${result.stdout}\n${result.stderr}`;
    if (item.expectOk) {
      const pass =
        result.code === 0 &&
        result.stdout.includes("ALL PASS") &&
        result.stdout.includes(`size=${OBSERVED_BODY_BYTES}`) &&
        result.stdout.includes(`Connection=${item.connection}`);
      if (pass) console.log(`PASS ${item.name} full body ${OBSERVED_BODY_BYTES} Connection=${item.connection}`);
      else {
        failures += 1;
        console.log(`FAIL ${item.name} code=${result.code}`);
      }
    } else {
      const pass =
        result.code !== 0 &&
        result.stdout.includes("Download failed") &&
        result.stderr.includes("read failed: -397") &&
        result.stderr.includes(`Incomplete: got ${OBSERVED_TAIL_STOP} of ${OBSERVED_BODY_BYTES}`);
      if (pass) {
        console.log(
          `PASS tail cut Download failed, SOCKET_PEER_CLOSED_E -397, Incomplete: got ${OBSERVED_TAIL_STOP} of ${OBSERVED_BODY_BYTES}`
        );
      } else {
        failures += 1;
        console.log(`FAIL tail cut code=${result.code}`);
        if (!combined.includes(String(OBSERVED_TAIL_STOP))) console.log(combined.slice(-2000));
      }
    }
  }
} finally {
  await tail.close();
}

console.log("\n=== on-device filenames (StringUtils::sanitizeFilename, AUTHOR_TITLE) ===");
for (const example of EXAMPLES) {
  const output = run(harness, ["--sanitize", "--title", example.title, "--author", example.author]);
  process.stdout.write(output);
}

console.log("\n=== picture budget (size workaround) and one uncapped text article ===");
for (const epub of FAILING_EPUBS) {
  if (!existsSync(epub.file)) {
    console.log(`SKIP validate-zip ${epub.file} (not present on this host)`);
    rows.push([epub.title, "missing", "", "", "", "", ""]);
    continue;
  }
  console.log(`\n=== repack ${epub.file} ===`);
  const before = readFileSync(epub.file);
  const beforeEntries = unzipSync(before);
  const started = Date.now();
  const after = await repackUnderBudget(before, {
    id: epub.file.split("/").pop().replace(/\.epub$/, ""),
    title: epub.title,
    author: epub.author
  });
  const afterEntries = unzipSync(after);
  const beforeChapter = strFromU8(beforeEntries["OEBPS/chapter.xhtml"]);
  const afterChapter = strFromU8(afterEntries["OEBPS/chapter.xhtml"]);
  const beforeText = visibleText(beforeChapter);
  const afterText = visibleText(afterChapter);
  const alts = altsKept(beforeChapter, afterChapter);
  const picturesBefore = jpgCount(beforeEntries);
  const picturesAfter = jpgCount(afterEntries);
  rows.push([epub.title, before.length, after.length, picturesBefore, picturesAfter, alts.before, alts.kept]);
  console.log(
    `BEFORE ${before.length} bytes pictures=${picturesBefore} alts=${alts.before} (a full body completes on this harness)`
  );
  console.log(
    `AFTER  ${after.length} bytes pictures=${picturesAfter} alts=${alts.kept} in ${Date.now() - started}ms budget ${EPUB_BYTE_BUDGET}`
  );
  if (after.length <= EPUB_BYTE_BUDGET && beforeText === afterText && alts.kept === alts.before) {
    console.log("PASS byte budget, text unchanged, alts kept");
  } else {
    failures += 1;
    console.log("FAIL byte budget, text changed, or alt dropped");
  }
  const repacked = epub.file.replace(/\.epub$/, ".repacked.epub");
  writeFileSync(repacked, after);
  try {
    process.stdout.write(run(harness, ["--validate-zip", epub.file, "--title", epub.title, "--author", epub.author]));
    process.stdout.write(run(harness, ["--validate-zip", repacked, "--title", epub.title, "--author", epub.author]));
  } catch (error) {
    failures += 1;
    process.stdout.write(error.stdout || "");
    process.stderr.write(error.stderr || "");
  }
}

{
  const before = Buffer.from(textOnlyAtLeast(UNCAPPED_TEXT_EXAMPLE_BYTES));
  const after = Buffer.from(
    await repackUnderBudget(before, { id: "text-only", title: "Text only article", author: "Example" })
  );
  const beforeEntries = unzipSync(before);
  const afterEntries = unzipSync(after);
  const beforeChapter = strFromU8(beforeEntries["OEBPS/chapter.xhtml"]);
  const afterChapter = strFromU8(afterEntries["OEBPS/chapter.xhtml"]);
  const alts = altsKept(beforeChapter, afterChapter);
  rows.push([
    "Text only article",
    before.length,
    after.length,
    jpgCount(beforeEntries),
    jpgCount(afterEntries),
    alts.before,
    alts.kept
  ]);
  console.log(`\n=== text-only article (at least ${UNCAPPED_TEXT_EXAMPLE_BYTES} bytes, still uncapped) ===`);
  console.log(`BEFORE ${before.length} bytes pictures=0`);
  console.log(`AFTER  ${after.length} bytes pictures=${jpgCount(afterEntries)} alts=${alts.kept}`);
  if (
    before.length >= UNCAPPED_TEXT_EXAMPLE_BYTES &&
    after.length === before.length &&
    visibleText(beforeChapter) === visibleText(afterChapter) &&
    jpgCount(afterEntries) === 0
  ) {
    console.log("PASS text-only article shipped whole, over the picture budget");
  } else {
    failures += 1;
    console.log("FAIL text-only article was capped or changed");
  }
}

const header = ["book", "before_bytes", "after_bytes", "pictures_before", "pictures_after", "alts_before", "alts_kept"];
const table = [header.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n") + "\n";
console.log("\n=== before / after ===");
console.log(table.trimEnd());
if (process.env.BEFORE_AFTER_PATH) writeFileSync(process.env.BEFORE_AFTER_PATH, table);

const password = process.env.OPDS_PASSWORD;
const live = Boolean(password);
let catalog;
const target = live
  ? { url: PRODUCTION, user: "ryan", password, label: "production https://rwopds.vercel.app/opds" }
  : null;

try {
  const creds = target ?? (catalog = await startFixtureCatalog(), {
    url: `${catalog.baseUrl}/opds`,
    user: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    label: `fixture ${catalog.baseUrl}/opds`
  });
  console.log(`\n=== device walk (${creds.label}) ===`);
  if (!live) {
    console.log("OPDS_PASSWORD unset; using the local fixture instead of production HTTPS");
  }
  const walked = await runHarness(harness, [
    "--url",
    creds.url,
    "--user",
    creds.user,
    "--password",
    creds.password,
    "--shelf",
    "Inbox",
    "--book-index",
    "0"
  ]);
  if (walked.code !== 0) failures += 1;
} finally {
  if (catalog) await catalog.close();
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
