#!/usr/bin/env node
// Agent control CLI for the local Readwise OPDS fixture catalog.
// Launch a mocked Readwise server, doctor it, walk it the way CrossInk on an
// Xteink X3 would, fetch individual routes, and stop only what this CLI started.
//
// Usage: node scripts/opds-cli.js --help
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";
import sharp from "sharp";

import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "./fixture-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const cliPath = fileURLToPath(import.meta.url);
const DEFAULT_STATE = join(repoRoot, ".cache/verify-opds/instance.json");
const DEFAULT_PORT = 8788;
const EVIDENCE_ROOT = join(repoRoot, ".cache/verify-opds/evidence");
const SHELVES = ["shortlist", "later", "archive"];
const SHELF_TITLES = ["Shortlist", "Later", "Archive"];
const FIXTURE_PAGE1_BOOKS = 50;
const FIXTURE_PAGE2_BOOKS = 1;
const X3 = { width: 528, height: 792 };

const usage = `Usage: opds-cli [global flags] <command> [command flags]

Drive the local Readwise OPDS fixture the way CrossInk on an Xteink X3 does:
HTTP Basic auth, Atom feeds at /opds, then EPUB download at /opds/books/<id>.epub.

Commands:
  launch   Start the mocked Readwise catalog (scripts/fixture-catalog.js)
  doctor   Read-only check that the instance is worth driving
  walk     Root menu -> one shelf -> next page -> EPUB through CrossInk parsers
  fetch    GET one catalog path (default: fixture Basic auth)
  stop     Stop the catalog this CLI started
  serve    Foreground server; launch spawns this. Stay attached for debugging.

Global flags:
  --json              Machine-readable stdout
  --state PATH        Instance file (default: .cache/verify-opds/instance.json)
  -h, --help          Show this help, or the help for a command

Environment:
  OPDS_CLI_STATE      Overrides the default --state path
  OPDS_CLI_PORT       Overrides the default launch port (${DEFAULT_PORT})

This CLI talks to the fixture catalog. It does not need a Readwise account.
Do not point launch at scripts/dev-server.js: that process needs a real token.

Examples:
  ./scripts/opds-cli launch
  ./scripts/opds-cli doctor --json
  ./scripts/opds-cli walk --shelf shortlist --feature shelf-feeds-and-paging
  ./scripts/opds-cli walk --all
  ./scripts/opds-cli fetch /opds
  ./scripts/opds-cli fetch /opds --no-auth --expect-status 401
  ./scripts/opds-cli stop --dry-run
  ./scripts/opds-cli stop

Exit codes: 0 on success, 1 on a failed check, 2 on usage or missing instance.
`;

const commandHelp = {
  launch: `Usage: opds-cli launch [--port PORT]

Start the mocked Readwise OPDS catalog in the background and wait until it is
ready (unauthenticated /opds is 401, authenticated /opds is 200).

Flags:
  --port PORT         Bind 127.0.0.1:PORT (default: ${DEFAULT_PORT}, or OPDS_CLI_PORT)
                      Use --port 0 to let the kernel pick an ephemeral port.

Writes .cache/verify-opds/instance.json (or --state). Refuses to start a second
catalog against the same state file while that pid is alive. Two instances can
run side by side with different --port and --state values.

Ready line: ready http://127.0.0.1:<port>/opds
`,
  doctor: `Usage: opds-cli doctor

Read-only. Answers "is this instance worth driving?" without changing state.

Checks:
  process   State pid is alive
  build     cmdline is opds-cli.js serve, cwd is this repo, kind is
            readwise-opds-fixture, /opds is a Readwise navigation feed that
            lists Shortlist, Later and Archive
  port      lsof shows that pid LISTENs on the recorded 127.0.0.1 port
  auth      GET /opds without credentials is 401 with
            WWW-Authenticate: Basic realm="Readwise OPDS";
            GET /opds with fixture credentials is 200
`,
  walk: `Usage: opds-cli walk [--shelf SHELF] [--books N] [--feature ID] [--all]

Drive the catalog the way CrossInk's OPDS browser does, using the PR #3
parser binaries from scripts/build-crossink-checks.sh.

Default: /opds -> /opds/<shelf> -> rel=next page -> first EPUB. Parses each
feed with opds-check-crossink, then the EPUB with xml-check and
opf-check-crossink, and checks every JPEG is baseline and within 528x792.

Flags:
  --shelf SHELF       shortlist | later | archive (default: shortlist)
  --books N           EPUBs to download from page 1 (default: 1)
  --feature ID        Stored in evidence meta.json
  --all               Run scripts/verify-crossink.js against this catalog
                      (every shelf, next page, one EPUB each, plus CrossPoint
                      comparison when those binaries build). Reuses the PR #3
                      harness instead of the single-shelf walk.

Evidence is written under .cache/verify-opds/evidence/<run-id>/ and is not
deleted by stop.
`,
  fetch: `Usage: opds-cli fetch <path> [--out FILE] [--no-auth] [--user U] [--password P] [--expect-status N]

GET one catalog path from the launched instance.

Arguments:
  path                Route beginning with / (example: /opds/shortlist)
                      or an absolute URL on the instance origin.

Flags:
  --out FILE          Write the body to FILE
  --no-auth           Omit the Authorization header
  --user U            Override the fixture username
  --password P        Override the fixture password
  --expect-status N   Exit 0 only when the status is N

Without --expect-status, any 2xx is success and anything else is a failure.
`,
  stop: `Usage: opds-cli stop [--dry-run]

Stop only the pid recorded in the state file. Never kills by process name.

Flags:
  --dry-run           Print the pid and port that would be signalled. Does not
                      send SIGTERM, does not remove the state file.

Removes the state file after a real stop. Leaves evidence and server.log.
`,
  serve: `Usage: opds-cli serve [--port PORT]

Foreground fixture catalog. launch spawns this detached. Use serve directly
when you want logs on the terminal.

Writes the state file once the port is bound, then stays up until SIGTERM
or SIGINT. Those signals close the HTTP server and exit 0. The state file is
left for stop to remove, unless serve is the only process (then it unlinks
its own state on a clean signal).
`
};

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");

function fail(message, hint, code = 2) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: message, hint: hint ?? null }));
  } else {
    console.error(`error: ${message}`);
    if (hint) console.error(hint);
  }
  process.exit(code);
}

function parseArgv(args) {
  const flags = {
    json: false,
    help: false,
    dryRun: false,
    all: false,
    noAuth: false,
    state: process.env.OPDS_CLI_STATE || DEFAULT_STATE,
    port: process.env.OPDS_CLI_PORT ? Number(process.env.OPDS_CLI_PORT) : DEFAULT_PORT,
    shelf: "shortlist",
    out: null,
    expectStatus: null,
    user: null,
    password: null,
    books: 1,
    timeoutMs: 15_000,
    feature: null
  };
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = () => {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) fail(`flag ${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--all":
        flags.all = true;
        break;
      case "--no-auth":
        flags.noAuth = true;
        break;
      case "--state":
        flags.state = resolve(take());
        break;
      case "--port":
        flags.port = Number(take());
        break;
      case "--shelf":
        flags.shelf = take();
        break;
      case "--out":
        flags.out = take();
        break;
      case "--expect-status":
        flags.expectStatus = Number(take());
        break;
      case "--user":
        flags.user = take();
        break;
      case "--password":
        flags.password = take();
        break;
      case "--books":
        flags.books = Number(take());
        break;
      case "--timeout-ms":
        flags.timeoutMs = Number(take());
        break;
      case "--feature":
        flags.feature = take();
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown flag ${arg}. Run opds-cli --help.`);
        positionals.push(arg);
    }
  }
  if (!Number.isFinite(flags.port) || flags.port < 0 || flags.port > 65535) {
    fail(`--port must be 0-65535, got ${flags.port}`);
  }
  if (!Number.isFinite(flags.books) || flags.books < 1) {
    fail(`--books must be a positive integer, got ${flags.books}`);
  }
  if (flags.expectStatus !== null && !Number.isFinite(flags.expectStatus)) {
    fail(`--expect-status must be a number`);
  }
  if (!isAbsolute(flags.state)) flags.state = resolve(flags.state);
  return { flags, positionals };
}

function emit(payload) {
  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.command === "launch") {
    console.log(`pid ${payload.pid}`);
    console.log(`state ${payload.stateFile}`);
    console.log(`ready ${payload.baseUrl}/opds`);
    return;
  }
  if (payload.command === "doctor") {
    for (const check of payload.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    console.log(payload.ok ? "doctor ok" : "doctor failed");
    return;
  }
  if (payload.command === "walk") {
    for (const step of payload.steps ?? []) {
      const extra = step.detail ? ` ${step.detail}` : "";
      console.log(`${step.ok ? "PASS" : "FAIL"} ${step.name}${extra}`);
    }
    if (payload.verifyLog) console.log(payload.verifyLog.trimEnd());
    console.log(`evidence ${payload.evidenceDir}`);
    console.log(payload.ok ? "walk ok" : "walk failed");
    return;
  }
  if (payload.command === "fetch") {
    console.log(`${payload.method} ${payload.url} ${payload.status}`);
    if (payload.wwwAuthenticate) console.log(`WWW-Authenticate: ${payload.wwwAuthenticate}`);
    if (payload.contentType) console.log(`Content-Type: ${payload.contentType}`);
    if (payload.savedTo) console.log(`saved ${payload.savedTo} (${payload.bytes} bytes)`);
    else if (payload.body !== undefined) process.stdout.write(payload.body);
    return;
  }
  if (payload.command === "stop") {
    if (payload.dryRun) {
      console.log(`dry-run: would stop pid ${payload.wouldStop.pid} on ${payload.wouldStop.baseUrl}`);
      console.log("state file left in place");
      return;
    }
    console.log(`stopped pid ${payload.stopped.pid} (${payload.stopped.baseUrl})`);
    return;
  }
  if (payload.command === "serve") {
    console.log(`ready ${payload.baseUrl}/opds`);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function cwdOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function listeningPids(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    fail("lsof is required for the port-ownership check. Install lsof, or run doctor on a host that has it.");
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return [...text.matchAll(/^\s*(\d+)\s*$/gm)].map((match) => Number(match[1]));
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    fail(`state file is not valid JSON: ${stateFile}`, error.message);
  }
}

function writeState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  rmSync(tmp, { force: true });
}

function requireInstance(stateFile) {
  const state = readState(stateFile);
  if (!state) {
    fail(
      `no catalog is running (missing ${stateFile})`,
      "Start one with: ./scripts/opds-cli launch"
    );
  }
  if (!isAlive(state.pid)) {
    fail(
      `state file names pid ${state.pid}, which is not running`,
      `Remove the stale file or run: ./scripts/opds-cli --state ${stateFile} launch`
    );
  }
  return state;
}

function authorization(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function httpGet(url, headers = {}) {
  const started = Date.now();
  const response = await fetch(url, { headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: Buffer.from(bytes).toString("utf8"),
    ms: Date.now() - started
  };
}

function parseOpdsOutput(output) {
  const entries = [...output.matchAll(/^(BOOK|NAV) +(.*?) \| (.*?) \| (https?:\/\/\S+) \|/gm)].map(
    ([, kind, title, author, href]) => ({ kind, title, author: author.trim(), href })
  );
  return {
    nextPage: /^next page: (.+)$/m.exec(output)?.[1] ?? "",
    prevPage: /^prev page: (.+)$/m.exec(output)?.[1] ?? "",
    truncated: /^truncated: (.+)$/m.exec(output)?.[1] ?? "",
    books: entries.filter((entry) => entry.kind === "BOOK"),
    nav: entries.filter((entry) => entry.kind === "NAV"),
    output
  };
}

function fieldOf(output, name) {
  return new RegExp(`^${name}: (.+)$`, "m").exec(output)?.[1] ?? "";
}

function newEvidenceDir(feature) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = (feature || "walk").replace(/[^\w.-]+/g, "-");
  const dir = join(EVIDENCE_ROOT, `${stamp}-${slug}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function buildCrossInkChecks() {
  const result = spawnSync(join(here, "build-crossink-checks.sh"), {
    encoding: "utf8",
    cwd: repoRoot
  });
  if (result.status !== 0) {
    fail(
      "failed to build CrossInk parser checks",
      `${result.stdout}${result.stderr}`.trim() || result.error?.message,
      1
    );
  }
  // The build script prints the bin directory on stdout and the pin on stderr.
  // Do not concatenate streams: the last stderr line is the pin, not the path.
  const bin = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1);
  if (!bin || !existsSync(join(bin, "opds-check-crossink"))) {
    fail(
      "CrossInk check binaries were not built",
      `expected opds-check-crossink under ${bin || "(empty stdout)"}\n${result.stderr || ""}`.trim(),
      1
    );
  }
  return bin;
}

function runTool(binDir, tool, args) {
  const result = spawnSync(join(binDir, tool), args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim(), status: result.status };
}

async function collectDoctor(stateFile) {
  const checks = [];
  const note = (name, ok, detail) => {
    checks.push({ name, ok, detail });
  };

  const state = readState(stateFile);
  if (!state) {
    note("process", false, `missing state file ${stateFile}`);
    return { ok: false, state: null, checks };
  }

  const alive = isAlive(state.pid);
  note("process", alive, alive ? `pid ${state.pid} is alive` : `pid ${state.pid} is not running`);
  if (!alive) return { ok: false, state, checks };

  const cmdline = cmdlineOf(state.pid);
  const cwd = cwdOf(state.pid);
  const serveOk = cmdline.includes("opds-cli.js") && cmdline.includes("serve");
  const cwdOk = cwd === repoRoot;
  const kindOk = state.kind === "readwise-opds-fixture";
  const buildBits = [];
  if (!serveOk) buildBits.push(`cmdline is not opds-cli.js serve (${cmdline || "unreadable"})`);
  if (!cwdOk) buildBits.push(`cwd ${cwd || "(unknown)"} is not ${repoRoot}`);
  if (!kindOk) buildBits.push(`kind ${JSON.stringify(state.kind)} is not readwise-opds-fixture`);
  if (serveOk && cwdOk && kindOk) {
    buildBits.push(`fixture catalog from ${repoRoot} (pid ${state.pid})`);
  }

  const owners = listeningPids(state.port);
  const portOk = owners.includes(state.pid);
  note(
    "port",
    portOk,
    portOk
      ? `127.0.0.1:${state.port} is owned by pid ${state.pid}`
      : `127.0.0.1:${state.port} owners=[${owners.join(",") || "none"}]; expected pid ${state.pid}`
  );

  let authOk = false;
  let feedOk = false;
  let authDetail = "did not fetch /opds";
  let feedDetail = "did not fetch /opds";
  try {
    const unauth = await httpGet(`${state.baseUrl}/opds`);
    const www = unauth.headers.get("www-authenticate") ?? "";
    const unauthOk = unauth.status === 401 && /Basic realm="Readwise OPDS"/.test(www);
    const authed = await httpGet(`${state.baseUrl}/opds`, {
      authorization: authorization(state.username, state.password)
    });
    const navType = authed.headers.get("content-type") ?? "";
    const titles = SHELF_TITLES.filter((title) => authed.text.includes(`<title>${title}</title>`));
    feedOk =
      authed.status === 200 &&
      navType.includes("profile=opds-catalog;kind=navigation") &&
      authed.text.includes("<title>Readwise</title>") &&
      titles.length === 3;
    authOk = unauthOk && authed.status === 200;
    authDetail = unauthOk
      ? `401 without credentials (WWW-Authenticate ${www}); ${authed.status} with ${state.username}`
      : `unauthenticated GET /opds returned ${unauth.status} (WWW-Authenticate ${www || "missing"})`;
    feedDetail = feedOk
      ? `Readwise navigation feed lists ${SHELF_TITLES.join(", ")}`
      : `authenticated /opds status=${authed.status} type=${navType} titles=[${titles.join(",")}]`;
  } catch (error) {
    authDetail = error.message;
    feedDetail = error.message;
  }

  note("build", serveOk && cwdOk && kindOk && feedOk, [...buildBits, feedDetail].join("; "));
  note("auth", authOk, authDetail);
  return { ok: checks.every((check) => check.ok), state, checks };
}

async function cmdLaunch(flags) {
  const existing = readState(flags.state);
  if (existing && isAlive(existing.pid)) {
    fail(
      `a catalog is already running at ${existing.baseUrl} (pid ${existing.pid})`,
      `Stop it with: ./scripts/opds-cli --state ${flags.state} stop`
    );
  }
  if (existing) rmSync(flags.state, { force: true });

  mkdirSync(dirname(flags.state), { recursive: true });
  const logFile = join(dirname(flags.state), "server.log");
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [cliPath, "serve", "--port", String(flags.port), "--state", flags.state], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: repoRoot,
    env: process.env
  });
  child.unref();

  const deadline = Date.now() + flags.timeoutMs;
  let lastError = "waiting for serve to write the state file";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!existsSync(flags.state)) {
      if (!isAlive(child.pid)) {
        fail("serve exited before it became ready", `See ${logFile}`, 1);
      }
      continue;
    }
    const doctor = await collectDoctor(flags.state);
    if (doctor.ok) {
      emit({
        ok: true,
        command: "launch",
        pid: doctor.state.pid,
        port: doctor.state.port,
        baseUrl: doctor.state.baseUrl,
        username: doctor.state.username,
        password: doctor.state.password,
        stateFile: flags.state,
        logFile,
        ready: true
      });
      return;
    }
    lastError = doctor.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    if (!isAlive(child.pid)) {
      fail("serve exited while doctor was failing", `${lastError}\nSee ${logFile}`, 1);
    }
  }
  fail(`catalog did not become ready within ${flags.timeoutMs} ms`, lastError, 1);
}

async function cmdDoctor(flags) {
  const result = await collectDoctor(flags.state);
  emit({
    ok: result.ok,
    command: "doctor",
    baseUrl: result.state?.baseUrl ?? null,
    pid: result.state?.pid ?? null,
    checks: result.checks
  });
  process.exit(result.ok ? 0 : 1);
}

function resolveFetchUrl(state, path) {
  if (/^https?:\/\//.test(path)) {
    const url = new URL(path);
    if (url.origin !== state.baseUrl) {
      fail(`URL origin ${url.origin} is not the launched catalog ${state.baseUrl}`);
    }
    return url.href;
  }
  if (!path.startsWith("/")) {
    fail(`path must start with / (got ${path})`, "Example: /opds/shortlist");
  }
  return `${state.baseUrl}${path}`;
}

async function cmdFetch(flags, path) {
  const state = requireInstance(flags.state);
  const url = resolveFetchUrl(state, path);
  const headers = {};
  if (!flags.noAuth) {
    headers.authorization = authorization(flags.user ?? state.username, flags.password ?? state.password);
  }
  const response = await httpGet(url, headers);
  const contentType = response.headers.get("content-type") ?? "";
  const wwwAuthenticate = response.headers.get("www-authenticate");
  let savedTo = null;
  if (flags.out) {
    const outPath = resolve(flags.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, response.bytes);
    savedTo = outPath;
  }
  const expect = flags.expectStatus;
  const ok = expect === null ? response.status >= 200 && response.status < 300 : response.status === expect;
  const textLike = /xml|atom|json|text\//.test(contentType);
  const payload = {
    ok,
    command: "fetch",
    method: "GET",
    url,
    path,
    status: response.status,
    ms: response.ms,
    bytes: response.bytes.length,
    contentType,
    wwwAuthenticate,
    savedTo,
    expectedStatus: expect
  };
  if (!savedTo && textLike && response.bytes.length <= 256_000) payload.body = response.text;
  emit(payload);
  if (!ok) process.exit(1);
}

async function inspectEpub(bytes, destDir, binDir) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "book.epub"), bytes);
  const mimetypeOk = Buffer.from(bytes.subarray(30, 38)).toString() === "mimetype";
  const files = unzipSync(bytes);
  const xmlPaths = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(destDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (/\.(xhtml|opf|ncx|xml)$/.test(name)) xmlPaths.push(path);
  }
  const wellFormed = runTool(binDir, "xml-check", xmlPaths);
  const opfPath = join(destDir, "OEBPS/content.opf");
  const opf = existsSync(opfPath) ? runTool(binDir, "opf-check-crossink", [opfPath]) : { ok: false, output: "missing OEBPS/content.opf" };
  writeFileSync(join(destDir, "opf-check.txt"), opf.output);
  writeFileSync(join(destDir, "xml-check.txt"), wellFormed.output);
  const images = [];
  for (const name of Object.keys(files).filter((file) => file.endsWith(".jpg"))) {
    const meta = await sharp(files[name]).metadata();
    const fits =
      meta.format === "jpeg" && !meta.isProgressive && meta.width <= X3.width && meta.height <= X3.height;
    images.push({
      name,
      format: meta.format,
      progressive: Boolean(meta.isProgressive),
      width: meta.width,
      height: meta.height,
      channels: meta.channels,
      fits
    });
  }
  writeFileSync(join(destDir, "images.json"), `${JSON.stringify(images, null, 2)}\n`);
  return {
    mimetypeOk,
    wellFormed,
    opf,
    images,
    title: fieldOf(opf.output, "title"),
    author: fieldOf(opf.output, "author"),
    cover: fieldOf(opf.output, "cover")
  };
}

async function cmdWalk(flags) {
  const state = requireInstance(flags.state);
  const evidenceDir = newEvidenceDir(flags.feature);
  const steps = [];
  const failures = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  writeFileSync(
    join(evidenceDir, "meta.json"),
    `${JSON.stringify(
      {
        feature: flags.feature,
        command: flags.all ? "walk --all" : "walk",
        shelf: flags.all ? SHELVES : flags.shelf,
        baseUrl: state.baseUrl,
        startedAt: new Date().toISOString(),
        crossinkPin: "v1.6.1 (9914146eeae7b46b300f475a16c32426fc02ec1f)"
      },
      null,
      2
    )}\n`
  );

  if (flags.all) {
    const result = spawnSync(process.execPath, [join(here, "verify-crossink.js"), state.baseUrl, String(flags.books)], {
      encoding: "utf8",
      cwd: repoRoot,
      env: { ...process.env, OPDS_USERNAME: state.username, OPDS_PASSWORD: state.password }
    });
    const log = `${result.stdout}${result.stderr}`;
    writeFileSync(join(evidenceDir, "verify-crossink.log"), log);
    const artifacts = /artifacts in (.+)\)$/m.exec(log)?.[1];
    if (artifacts && existsSync(artifacts)) {
      cpSync(artifacts, join(evidenceDir, "verify-crossink-artifacts"), { recursive: true });
    }
    const ok = result.status === 0 && /ALL PASS/.test(log);
    check("verify:crossink", ok, ok ? `ALL PASS (copied artifacts)` : `exit ${result.status}`);
    emit({
      ok,
      command: "walk",
      mode: "all",
      evidenceDir,
      steps,
      verifyLog: log,
      exitCode: result.status
    });
    process.exit(ok ? 0 : 1);
  }

  if (!SHELVES.includes(flags.shelf)) {
    fail(`unknown shelf ${flags.shelf}`, `Use one of: ${SHELVES.join(", ")}`);
  }

  const binDir = buildCrossInkChecks();
  const headers = { authorization: authorization(state.username, state.password) };

  const parseFeed = async (url, name) => {
    const response = await httpGet(url, headers);
    const xmlPath = join(evidenceDir, `${name}.xml`);
    writeFileSync(xmlPath, response.bytes);
    const parsed = runTool(binDir, "opds-check-crossink", [xmlPath]);
    writeFileSync(join(evidenceDir, `${name}.opds.txt`), parsed.output);
    const fields = parseOpdsOutput(parsed.output);
    check(`${name} status`, response.status === 200, `${response.status} in ${response.ms} ms`);
    check(`${name} CrossInk parse`, parsed.ok, parsed.ok ? `truncated=${fields.truncated}` : parsed.output);
    return { response, fields };
  };

  const root = await parseFeed(`${state.baseUrl}/opds`, "root");
  const navTitles = root.fields.nav.map((entry) => entry.title);
  check(
    "root menu titles",
    JSON.stringify(navTitles) === JSON.stringify(SHELF_TITLES),
    `got ${navTitles.join(", ") || "(none)"}`
  );

  const shelfTitle = flags.shelf.charAt(0).toUpperCase() + flags.shelf.slice(1);
  const shelfNav = root.fields.nav.find((entry) => entry.title === shelfTitle);
  check("root has shelf", Boolean(shelfNav), shelfNav ? shelfNav.href : `missing NAV ${shelfTitle}`);
  if (!shelfNav) {
    emit({ ok: false, command: "walk", shelf: flags.shelf, evidenceDir, steps });
    process.exit(1);
  }

  const page1 = await parseFeed(shelfNav.href, `${flags.shelf}-page1`);
  check(
    `${flags.shelf} page 1 count`,
    page1.fields.books.length === FIXTURE_PAGE1_BOOKS,
    `${page1.fields.books.length} BOOK entries (fixture page size is ${FIXTURE_PAGE1_BOOKS})`
  );
  check(
    `${flags.shelf} page 1 not truncated`,
    page1.fields.truncated === "no",
    `truncated=${page1.fields.truncated || "(missing)"} (CrossInk MAX_OPDS_FEED_ENTRIES=50)`
  );
  check(`${flags.shelf} next page`, Boolean(page1.fields.nextPage), page1.fields.nextPage || "missing rel=next");

  if (page1.fields.nextPage) {
    const page2 = await parseFeed(page1.fields.nextPage, `${flags.shelf}-page2`);
    check(
      `${flags.shelf} page 2 count`,
      page2.fields.books.length === FIXTURE_PAGE2_BOOKS,
      `${page2.fields.books.length} BOOK entries`
    );
  }

  const books = page1.fields.books.slice(0, flags.books);
  check(`${flags.shelf} has books to download`, books.length > 0, `${books.length} selected`);
  for (const book of books) {
    const response = await httpGet(book.href, headers);
    const label = book.title.slice(0, 48);
    check(
      `download ${label}`,
      response.status === 200,
      `${response.status}, ${(response.bytes.length / 1024).toFixed(0)} KB, ${response.ms} ms`
    );
    if (response.status !== 200) continue;
    const dest = join(evidenceDir, book.href.split("/").at(-1).replace(/\.epub$/, ""));
    const inspected = await inspectEpub(response.bytes, dest, binDir);
    check(`mimetype ${label}`, inspected.mimetypeOk, inspected.mimetypeOk ? "first zip entry is mimetype" : "missing");
    check(
      `XML ${label}`,
      inspected.wellFormed.ok,
      inspected.wellFormed.ok ? "expat well-formed" : inspected.wellFormed.output
    );
    check(
      `OPF ${label}`,
      inspected.opf.ok && Boolean(inspected.title),
      inspected.opf.ok ? `title=${inspected.title}` : inspected.opf.output
    );
    for (const image of inspected.images) {
      check(
        `${label} ${image.name}`,
        image.fits,
        `${image.width}x${image.height} ${image.format} progressive=${image.progressive}`
      );
    }
  }

  const ok = failures.length === 0;
  writeFileSync(join(evidenceDir, "walk.json"), `${JSON.stringify({ ok, steps, failures }, null, 2)}\n`);
  emit({ ok, command: "walk", shelf: flags.shelf, evidenceDir, steps, failures });
  process.exit(ok ? 0 : 1);
}

async function cmdStop(flags) {
  const state = readState(flags.state);
  if (!state) {
    fail(`no catalog is running (missing ${flags.state})`, "Nothing to stop.");
  }
  if (flags.dryRun) {
    emit({
      ok: true,
      command: "stop",
      dryRun: true,
      wouldStop: { pid: state.pid, port: state.port, baseUrl: state.baseUrl, alive: isAlive(state.pid) }
    });
    return;
  }
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch (error) {
      fail(`could not signal pid ${state.pid}`, error.message, 1);
    }
    const deadline = Date.now() + 5000;
    while (isAlive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (isAlive(state.pid)) {
      process.kill(state.pid, "SIGKILL");
    }
  }
  rmSync(flags.state, { force: true });
  emit({
    ok: true,
    command: "stop",
    dryRun: false,
    stopped: { pid: state.pid, port: state.port, baseUrl: state.baseUrl }
  });
}

async function cmdServe(flags) {
  let catalog;
  try {
    catalog = await startFixtureCatalog({ port: flags.port });
  } catch (error) {
    fail(`could not bind the fixture catalog: ${error.message}`, null, 1);
  }
  const bound = Number(new URL(catalog.baseUrl).port);
  const state = {
    kind: "readwise-opds-fixture",
    pid: process.pid,
    port: bound,
    host: "127.0.0.1",
    baseUrl: catalog.baseUrl,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    repoRoot,
    startedAt: new Date().toISOString(),
    stateFile: flags.state
  };
  writeState(flags.state, state);

  const shutdown = async () => {
    await catalog.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  emit({ ok: true, command: "serve", ...state, ready: true });
}

const { flags, positionals } = parseArgv(argv);
const command = positionals[0];

if (flags.help && !command) {
  console.log(usage);
  process.exit(0);
}
if (!command) fail("missing command", usage.trim());
if (flags.help) {
  console.log(commandHelp[command] ?? `No help for ${command}.\n\n${usage}`);
  process.exit(commandHelp[command] ? 0 : 2);
}
if (command === "fetch" && !positionals[1]) fail("fetch needs a path", commandHelp.fetch.trim());
if (flags.dryRun && command !== "stop") {
  fail(`--dry-run is only valid on stop (the only destructive command)`, `You passed it to ${command}.`);
}

const commands = {
  launch: () => cmdLaunch(flags),
  doctor: () => cmdDoctor(flags),
  walk: () => cmdWalk(flags),
  fetch: () => cmdFetch(flags, positionals[1]),
  stop: () => cmdStop(flags),
  serve: () => cmdServe(flags)
};

if (!commands[command]) fail(`unknown command ${command}`, usage.trim());

commands[command]().catch((error) => {
  fail(error.message, error.stack, 1);
});
