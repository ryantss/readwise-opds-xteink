#!/usr/bin/env node
// Drive CrossInk v1.6.1's own HTTP + OPDS + FatFs download path on the host.
// Preferred target is https://rwopds.vercel.app/opds with username ryan and
// OPDS_PASSWORD. When that env is unset, the fixture catalog is used instead.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "./fixture-catalog.js";

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

console.log("=== cannot model ===");
console.log("- real ESP32 heap size and fragmentation (wolfSSL record buffers, ZipFile EOCD scan)");
console.log("- WiFi association, RSSI, and stall/retry timing (DOWNLOAD_IDLE_TIMEOUT_MS=30000 still applies)");
console.log("- real SD card behaviour (SdFat 2.3.1 on SPI vs host FatFs on a 64MB image file)");
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
  try {
    process.stdout.write(
      run(harness, ["--validate-zip", epub.file, "--title", epub.title, "--author", epub.author])
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
