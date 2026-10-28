// End-to-end check of a running readwise-opds server through CrossInk's own
// parsers (v1.6.1, X3 default env): menu and shelf feeds via OpdsParser, each
// EPUB's XML via expat and its OPF via ContentOpfParser, and images against
// what the X3 decodes well. Defaults to a mocked Readwise catalog so it runs
// without an account. Pass a URL to walk a live server instead.
//
// When CrossPoint's check binaries can be built, the same feeds and EPUBs are
// also parsed with those, and every structural difference is printed.
//
// Usage: node scripts/verify-crossink.js [base-url] [books-per-shelf]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";
import sharp from "sharp";

import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "./fixture-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const CROSSINK_TAG = "v1.6.1";
const CROSSINK_SHA = "9914146eeae7b46b300f475a16c32426fc02ec1f";
const [baseUrlArg, bookCount = "1"] = process.argv.slice(2);

const failures = [];
const differences = [];

function check(ok, message) {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

function noteDifference(message) {
  console.log(`DIFF ${message}`);
  differences.push(message);
}

function run(binDir, tool, args) {
  const result = spawnSync(join(binDir, tool), args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

async function fetchTimed(url, headers) {
  const started = Date.now();
  const response = await fetch(url, { headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, ms: Date.now() - started };
}

const entriesOf = (output, kind) =>
  [...output.matchAll(new RegExp(`^${kind} +(.+?) \\| (.*?) \\| (https?:\\/\\/\\S+) \\|`, "gm"))].map(
    ([, title, author, href]) => ({ title, author: author.trim(), href })
  );

const nextPageOf = (output) => /^next page: (.+)$/m.exec(output)?.[1] ?? "";
const fieldOf = (output, name) => new RegExp(`^${name}: (.+)$`, "m").exec(output)?.[1] ?? "";

function compareEntries(name, leftLabel, leftOutput, rightLabel, rightOutput) {
  const kinds = ["NAV", "BOOK"];
  for (const kind of kinds) {
    const left = entriesOf(leftOutput, kind);
    const right = entriesOf(rightOutput, kind);
    if (left.length !== right.length) {
      noteDifference(`${name}: ${leftLabel} has ${left.length} ${kind} entries, ${rightLabel} has ${right.length}`);
      continue;
    }
    for (let i = 0; i < left.length; i++) {
      if (left[i].title !== right[i].title) {
        noteDifference(`${name} ${kind} #${i + 1} title: ${leftLabel}=${JSON.stringify(left[i].title)} ${rightLabel}=${JSON.stringify(right[i].title)}`);
      }
      if (left[i].author !== right[i].author) {
        noteDifference(`${name} ${kind} #${i + 1} author: ${leftLabel}=${JSON.stringify(left[i].author)} ${rightLabel}=${JSON.stringify(right[i].author)}`);
      }
      if (left[i].href !== right[i].href) {
        noteDifference(`${name} ${kind} #${i + 1} href: ${leftLabel}=${JSON.stringify(left[i].href)} ${rightLabel}=${JSON.stringify(right[i].href)}`);
      }
    }
  }
  const leftNext = nextPageOf(leftOutput);
  const rightNext = nextPageOf(rightOutput);
  if (leftNext !== rightNext) {
    noteDifference(`${name} next page: ${leftLabel}=${JSON.stringify(leftNext)} ${rightLabel}=${JSON.stringify(rightNext)}`);
  }
}

function compareOpf(label, leftLabel, leftOutput, rightLabel, rightOutput) {
  for (const field of ["title", "author", "language", "toc ncx", "toc nav", "cover"]) {
    const left = fieldOf(leftOutput, field);
    const right = fieldOf(rightOutput, field);
    if (left !== right) {
      noteDifference(`${label} OPF ${field}: ${leftLabel}=${JSON.stringify(left)} ${rightLabel}=${JSON.stringify(right)}`);
    }
  }
}

function buildChecks(script, label) {
  try {
    const output = execFileSync(join(here, script), { encoding: "utf8" });
    const bin = output.trim().split("\n").at(-1);
    console.log(`built ${label} checks in ${bin}`);
    return bin;
  } catch (error) {
    const detail = error.stderr?.toString() || error.message;
    console.error(`failed to build ${label} checks:\n${detail}`);
    return null;
  }
}

const catalog = baseUrlArg ? null : await startFixtureCatalog();
const baseUrl = baseUrlArg || catalog.baseUrl;
const username = catalog ? catalog.username : process.env.OPDS_USERNAME;
const password = catalog ? catalog.password : process.env.OPDS_PASSWORD;
if (!username || !password) {
  console.error("OPDS_USERNAME and OPDS_PASSWORD are required when verifying a live URL");
  process.exit(2);
}

console.log(`CrossInk pin: ${CROSSINK_TAG} (${CROSSINK_SHA})`);
console.log(`catalog: ${baseUrl}${catalog ? " (mocked Readwise fixture)" : ""}`);
console.log(`command: node scripts/verify-crossink.js${baseUrlArg ? ` ${baseUrlArg} ${bookCount}` : ""}`);

const crossinkBin = buildChecks("build-crossink-checks.sh", "CrossInk");
if (!crossinkBin) {
  if (catalog) await catalog.close();
  process.exit(1);
}
const crosspointBin = buildChecks("build-crosspoint-checks.sh", "CrossPoint");

const work = mkdtempSync(join(tmpdir(), "readwise-opds-crossink-"));
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const SHELVES = ["Shortlist", "Later", "Archive"];
const CROSSINK_OPDS = "opds-check-crossink";
const CROSSPOINT_OPDS = ["opds-check-1.6.5", "opds-check"];

async function checkFeed(url, name) {
  const feed = await fetchTimed(url, { authorization });
  check(feed.response.status === 200, `${name} responds 200 (${feed.response.status}, ${feed.ms} ms)`);
  const path = join(work, `${name.replace(/\W+/g, "-")}.xml`);
  writeFileSync(path, feed.bytes);

  const crossink = run(crossinkBin, CROSSINK_OPDS, [path]);
  check(crossink.ok, `${name} parses in CrossInk ${CROSSINK_OPDS}${crossink.ok ? "" : `: ${crossink.output}`}`);
  if (/^truncated: yes$/m.test(crossink.output)) {
    noteDifference(`${name}: CrossInk truncated the feed (more than ${50} entries)`);
  }

  const crosspointOutputs = {};
  if (crosspointBin) {
    for (const parser of CROSSPOINT_OPDS) {
      const parsed = run(crosspointBin, parser, [path]);
      check(parsed.ok, `${name} parses in CrossPoint ${parser}${parsed.ok ? "" : `: ${parsed.output}`}`);
      crosspointOutputs[parser] = parsed.output;
      if (parsed.ok && crossink.ok) compareEntries(name, `CrossInk ${CROSSINK_OPDS}`, crossink.output, `CrossPoint ${parser}`, parsed.output);
    }
  }
  return { crossink: crossink.output, crosspoint: crosspointOutputs };
}

try {
  const unauthenticated = await fetch(`${baseUrl}/opds`);
  check(unauthenticated.status === 401, `feed without credentials is rejected (${unauthenticated.status})`);

  const root = await checkFeed(`${baseUrl}/opds`, "root menu");
  const nav = entriesOf(root.crossink, "NAV");
  check(
    JSON.stringify(nav.map((entry) => entry.title)) === JSON.stringify(SHELVES),
    `root menu lists ${SHELVES.join(", ")} (got ${nav.map((entry) => entry.title).join(", ")})`
  );

  const books = [];
  for (const shelf of nav) {
    const page1 = await checkFeed(shelf.href, `${shelf.title} feed`);
    const shelfBooks = entriesOf(page1.crossink, "BOOK");
    check(shelfBooks.length > 0, `${shelf.title} feed has books (${shelfBooks.length} on page 1)`);
    console.log(shelfBooks.slice(0, 3).map((book) => `    ${book.title}`).join("\n"));
    books.push(...shelfBooks.slice(0, Number(bookCount)));

    const nextPage = nextPageOf(page1.crossink);
    check(Boolean(nextPage), `${shelf.title} feed has a next-page link`);
    if (nextPage) await checkFeed(nextPage, `${shelf.title} page 2`);
  }

  for (const { title, href } of books) {
    const book = await fetchTimed(href, { authorization });
    const label = `"${title}"`;
    check(
      book.response.status === 200,
      `${label} downloads (${book.response.status}, ${(book.bytes.length / 1024).toFixed(0)} KB, ${book.ms} ms)`
    );
    if (book.response.status !== 200) continue;

    check(Buffer.from(book.bytes.subarray(30, 38)).toString() === "mimetype", `${label} starts with the mimetype entry`);

    const files = unzipSync(book.bytes);
    const dir = join(work, href.split("/").at(-1));
    const xmlPaths = [];
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      if (/\.(xhtml|opf|ncx|xml)$/.test(name)) xmlPaths.push(path);
    }

    const wellFormed = run(crossinkBin, "xml-check", xmlPaths);
    check(wellFormed.ok, `${label} XML is well-formed under expat${wellFormed.ok ? "" : `: ${wellFormed.output}`}`);

    const opfPath = join(dir, "OEBPS/content.opf");
    const opf = run(crossinkBin, "opf-check-crossink", [opfPath]);
    check(opf.ok, `${label} OPF parses in CrossInk ContentOpfParser`);
    console.log(opf.output.replace(/^/gm, "    "));

    if (crosspointBin) {
      const crosspointOpf = run(crosspointBin, "opf-check", [opfPath]);
      check(crosspointOpf.ok, `${label} OPF parses in CrossPoint ContentOpfParser`);
      if (opf.ok && crosspointOpf.ok) compareOpf(label, "CrossInk", opf.output, "CrossPoint", crosspointOpf.output);
    }

    for (const name of Object.keys(files).filter((file) => file.endsWith(".jpg"))) {
      const meta = await sharp(files[name]).metadata();
      const fits = meta.format === "jpeg" && !meta.isProgressive && meta.width <= 528 && meta.height <= 792;
      check(fits, `${label} ${name} is a baseline JPEG within 528x792 (${meta.width}x${meta.height}, ${meta.channels}ch)`);
    }
  }
} finally {
  if (catalog) await catalog.close();
}

console.log("\n--- Parse differences (CrossInk v1.6.1 vs CrossPoint) ---");
if (differences.length === 0) {
  console.log("None on this catalog. CrossInk and CrossPoint agreed on entry type, title, author, href, next-page, and OPF metadata.");
} else {
  for (const item of differences) console.log(`- ${item}`);
}

console.log(`\nCrossInk pin: ${CROSSINK_TAG} (${CROSSINK_SHA})`);
console.log(`${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`} (artifacts in ${work})`);
process.exit(failures.length === 0 ? 0 : 1);
