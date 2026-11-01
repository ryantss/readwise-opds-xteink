#!/usr/bin/env node
// Drive CrossInk v1.6.1's own HTTP + OPDS + FatFs download path on the host.
// Preferred target is https://rwopds.vercel.app/opds with username ryan and
// OPDS_PASSWORD. When that env is unset, the fixture catalog is used instead.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strFromU8, unzipSync } from "fflate";

import { EPUB_BYTE_BUDGET, x3DownloadOutcome } from "../src/core/budget.js";
import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "./fixture-catalog.js";
import { repackUnderBudget, visibleText } from "./repack-under-budget.js";

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

// Must not block the event loop: the fixture catalog is served from this process.
function runLive(bin, args) {
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
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${bin} exited ${code}`), { stdout, stderr, status: code }));
    });
  });
}

console.log("=== device limit this harness can score ===");
console.log(
  "CrossInk #836: wolfSSL MEMORY_E after 219615 bytes, max block 13300. Vercel ignores max_fragment_length (2KB), so TLS records stay up to 16KB."
);
console.log(`EPUB budget ${EPUB_BYTE_BUDGET} bytes. A body past the published #836 prefix is scored as a failed read.`);
for (const known of [
  ["01m6ayz163q7d673wrkq76hcn1.epub", 502491],
  ["01m5ad7pndwt54mkgwpg845shq.epub", 293924],
  ["01m62s8vznfmgdxc37yevr5efq.epub", 681709]
]) {
  const outcome = x3DownloadOutcome(known[1]);
  console.log(
    `  ${known[0]} ${known[1]} bytes -> ${outcome.ok ? "complete" : `MEMORY_E at ${outcome.received}/${outcome.total}`}`
  );
}
const videoBytes = 502491;
const lastTick = Math.floor(videoBytes / (64 * 1024)) * (64 * 1024);
console.log("");
console.log("=== 1 Nov video, primary article ===");
console.log("The Rise of the Self-Driving Company, Amjad Masad, id 01m6ayz163q7d673wrkq76hcn1");
console.log(`production GET twice, 200, Content-Length ${videoBytes}. The bytes were not saved here.`);
console.log(
  `last 64KB progress tick is ${lastTick} bytes (${((100 * lastTick) / videoBytes).toFixed(1)}%). The forced 100% notify runs only after responseComplete(), before sync, the size check, ZipFile validate, and .part publish.`
);
console.log(
  "The scored stop at 212992/502491 is the earlier #836 prefix. It is not the bar on this screen. wolfSSL retains the 16KB record buffer, and a read that reached this tick had already allocated it."
);
console.log("");
console.log("=== still cannot model ===");
console.log("- the exact byte where Ryan's X3 stopped (no serial log; the screen has no counts)");
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

console.log("\n=== on-device filenames (StringUtils::sanitizeFilename, AUTHOR_TITLE) ===");
for (const example of EXAMPLES) {
  const output = run(harness, ["--sanitize", "--title", example.title, "--author", example.author]);
  process.stdout.write(output);
}

let failures = 0;
for (const epub of FAILING_EPUBS) {
  if (!existsSync(epub.file)) {
    console.log(`SKIP validate-zip ${epub.file} (not present on this host)`);
    continue;
  }
  console.log(`\n=== validate attached EPUB on FAT: ${epub.file} ===`);
  const before = readFileSync(epub.file);
  const beforeRead = x3DownloadOutcome(before.length);
  console.log(
    `BEFORE ${before.length} bytes ${beforeRead.ok ? "complete" : `MEMORY_E at ${beforeRead.received}/${beforeRead.total}`}`
  );
  const started = Date.now();
  const after = await repackUnderBudget(before, {
    id: epub.file.split("/").pop().replace(/\.epub$/, ""),
    title: epub.title,
    author: epub.author
  });
  const afterRead = x3DownloadOutcome(after.length);
  const beforeText = visibleText(strFromU8(unzipSync(before)["OEBPS/chapter.xhtml"]));
  const afterText = visibleText(strFromU8(unzipSync(after)["OEBPS/chapter.xhtml"]));
  console.log(`AFTER  ${after.length} bytes in ${Date.now() - started}ms ${afterRead.ok ? "complete" : "FAIL"} budget ${EPUB_BYTE_BUDGET}`);
  if (!beforeRead.ok && afterRead.ok && after.length <= EPUB_BYTE_BUDGET && beforeText === afterText) {
    console.log("PASS byte budget, text unchanged");
  } else {
    failures += 1;
    console.log("FAIL byte budget or text changed");
  }
  const repacked = epub.file.replace(/\.epub$/, ".repacked.epub");
  writeFileSync(repacked, after);
  try {
    process.stdout.write(
      run(harness, ["--validate-zip", epub.file, "--title", epub.title, "--author", epub.author])
    );
    process.stdout.write(
      run(harness, ["--validate-zip", repacked, "--title", epub.title, "--author", epub.author])
    );
  } catch (error) {
    failures += 1;
    process.stdout.write(error.stdout || "");
    process.stderr.write(error.stderr || "");
  }
}

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
  try {
    await runLive(harness, [
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
  } catch (error) {
    failures += 1;
    if (!error.stdout && !error.stderr) console.error(error.message || error);
  }
} finally {
  if (catalog) await catalog.close();
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
