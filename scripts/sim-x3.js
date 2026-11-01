#!/usr/bin/env node
// Headless CrossInk v1.6.1 X3 simulator walk: local catalog on :8787, official
// PlatformIO native SDL binary (env:simulator-X3), keys and screenshots after
// log events, then the PR #12 device harness against the same catalog.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { startFixtureCatalog } from "./fixture-catalog.js";
import { SCREEN_NAMES, assertWalkEvidence, jpegError4 } from "./crossink-sim/walk-gates.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CROSSINK_TAG = "v1.6.1";
const CROSSINK_SHA = "9914146eeae7b46b300f475a16c32426fc02ec1f";
const DEFAULT_PORT = 8787;
const DEFAULT_USER = "ryan";
const DEFAULT_PASSWORD = "x3-sim-test";
const DOWNLOAD_HOLD_MS = 2500;
const WALK_DEADLINE_MS = 180_000;
const BUILD_DEADLINE_MS = 600_000;
const HARNESS_DEADLINE_MS = 180_000;

const port = Number(process.env.SIM_X3_PORT || DEFAULT_PORT);
const username = process.env.OPDS_USERNAME || process.env.SIM_X3_USERNAME || DEFAULT_USER;
const password = process.env.OPDS_PASSWORD || process.env.SIM_X3_PASSWORD || DEFAULT_PASSWORD;
const liveToken = Boolean(process.env.READWISE_TOKEN);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = join(root, ".cache", "crossink-sim", "evidence", runId);
const artifactRoot = process.env.SIM_X3_ARTIFACTS || "/opt/cursor/artifacts";
const controlDir = join(evidence, "control");
mkdirSync(evidence, { recursive: true });
mkdirSync(join(evidence, "screens"), { recursive: true });
mkdirSync(controlDir, { recursive: true });

function log(line) {
  const text = `${line}\n`;
  process.stdout.write(text);
  writeFileSync(join(evidence, "sim-x3.log"), text, { flag: "a" });
}

function which(cmd) {
  const result = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function seedOpds(sdRoot, catalogUrl) {
  const hidden = join(sdRoot, ".crosspoint");
  mkdirSync(hidden, { recursive: true });
  writeFileSync(
    join(hidden, "opds.json"),
    JSON.stringify(
      {
        servers: [
          {
            name: "Readwise",
            url: catalogUrl,
            username,
            password,
            filenameFormat: "author_title"
          }
        ]
      },
      null,
      2
    )
  );
}

function writeAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function bmpToPng(bmpPath, pngPath) {
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required to convert simulator BMP screenshots");
  const result = spawnSync(ffmpeg, ["-y", "-i", bmpPath, pngPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${bmpPath}: ${result.stderr || result.status}`);
  }
}

function spawnLogged(cmd, args, env, logFile, timeoutMs) {
  const out = createWriteStream(logFile, { flags: "a" });
  const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let captured = "";
  child.stdout.on("data", (chunk) => {
    captured += chunk;
    out.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    captured += chunk;
    out.write(chunk);
    process.stderr.write(chunk);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`FAIL ${cmd} exceeded ${timeoutMs}ms; sending SIGTERM`);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  }, timeoutMs);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end();
      if (timedOut) {
        reject(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { status: code, timedOut: true }));
        return;
      }
      if (code === 0) resolve(captured);
      else reject(Object.assign(new Error(`${cmd} exited ${code ?? signal}`), { status: code, stdout: captured }));
    });
  });
  return { child, done, getLog: () => captured };
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function simLogText(walk) {
  const file = join(evidence, "simulator.log");
  const disk = existsSync(file) ? readFileSync(file, "utf8") : "";
  return (walk?.getLog?.() || "") + disk;
}

async function waitLog(walk, pattern, timeoutMs, label = String(pattern), since = 0) {
  const regex = typeof pattern === "string" ? new RegExp(pattern, "m") : pattern;
  await waitFor(() => regex.test(simLogText(walk).slice(since)), timeoutMs, label);
}

async function sendKey(key) {
  const path = join(controlDir, "key");
  writeAtomic(path, `${key}\n`);
  await waitFor(() => !existsSync(path), 4000, `sim consume key ${key}`);
  await delay(120);
}

async function takeShot(name) {
  const bmp = join(evidence, "screens", `${name}.bmp`);
  writeAtomic(join(controlDir, "shot"), `${bmp}\n`);
  await waitFor(() => existsSync(bmp) && readFileSync(bmp).length > 100, 8000, `screenshot ${name}`);
  log(`captured ${name}`);
}

function findEpub(sd) {
  const result = spawnSync("find", [sd, "-name", "*.epub"], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(0);
}

log(`CrossInk pin ${CROSSINK_TAG} ${CROSSINK_SHA}`);
log(`evidence ${evidence}`);

let catalog;
let catalogProc;
const catalogUrl = `http://127.0.0.1:${port}/opds`;

try {
  if (liveToken) {
    log(`catalog: scripts/dev-server.js :${port} (READWISE_TOKEN set)`);
    catalogProc = spawn(process.execPath, [join(here, "dev-server.js"), String(port)], {
      cwd: root,
      env: { ...process.env, OPDS_USERNAME: username, OPDS_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const catalogLog = createWriteStream(join(evidence, "catalog.log"));
    catalogProc.stdout.pipe(catalogLog);
    catalogProc.stderr.pipe(catalogLog);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dev-server did not bind")), 15_000);
      catalogProc.stdout.on("data", (chunk) => {
        if (String(chunk).includes("/opds")) {
          clearTimeout(timer);
          resolve();
        }
      });
      catalogProc.on("error", reject);
    });
  } else {
    log(`catalog: fixture on :${port} user=${username} (no READWISE_TOKEN)`);
    catalog = await startFixtureCatalog({
      port,
      username,
      password,
      downloadDelayMs: DOWNLOAD_HOLD_MS
    });
    writeFileSync(join(evidence, "catalog.log"), `fixture ${catalog.baseUrl}/opds delay=${DOWNLOAD_HOLD_MS}ms\n`);
  }

  const probe = await fetch(catalogUrl, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
  });
  if (probe.status !== 200) {
    throw new Error(`catalog ${catalogUrl} returned ${probe.status}`);
  }
  log(`PASS catalog ${catalogUrl} status=200`);

  log("=== build simulator-X3 ===");
  const built = spawnLogged(
    join(here, "build-crossink-simulator.sh"),
    [],
    { ...process.env, PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH}` },
    join(evidence, "build.log"),
    BUILD_DEADLINE_MS
  );
  const buildOut = await built.done;
  writeFileSync(join(evidence, "build.stdout"), buildOut);
  const program = buildOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("/program"))
    .at(-1);
  if (!program || !existsSync(program)) throw new Error(`simulator binary missing: ${program || "(no path in build log)"}`);
  log(`PASS build ${program}`);

  const sd = join(root, ".cache", "crossink-sim", "sd", runId);
  mkdirSync(sd, { recursive: true });
  seedOpds(sd, catalogUrl);
  log(`seeded ${sd}/.crosspoint/opds.json -> ${catalogUrl}`);

  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH}`,
    CROSSPOINT_SIM_SD: sd,
    CROSSINK_SIM_CONTROL: controlDir
  };

  const xvfb = which("xvfb-run");
  const simArgs = xvfb
    ? [xvfb, "-a", "-s", "-screen 0 1024x768x24", program]
    : [program];
  if (!xvfb) {
    env.SDL_VIDEODRIVER = process.env.SDL_VIDEODRIVER || "offscreen";
    log("xvfb-run missing; using SDL_VIDEODRIVER=" + env.SDL_VIDEODRIVER);
  } else {
    log("running simulator under xvfb-run");
  }

  log("=== simulator walk (event-driven) ===");
  const walk = spawnLogged(simArgs[0], simArgs.slice(1), env, join(evidence, "simulator.log"), WALK_DEADLINE_MS);

  try {
    await waitLog(walk, "Entering activity: Home", 20_000, "Home");
    await delay(400);
    await takeShot("01-home");

    await sendKey("DOWN");
    await sendKey("DOWN");
    await sendKey("ENTER");
    await waitLog(walk, "Entering activity: OpdsBookBrowser", 15_000, "OpdsBookBrowser");
    await waitLog(walk, "Fetching: http://127\\.0\\.0\\.1:\\d+/opds\\b", 15_000, "catalog fetch");
    await delay(800);
    await takeShot("02-catalog");

    await sendKey("ENTER");
    await waitLog(walk, "Fetching: http://127\\.0\\.0\\.1:\\d+/opds/inbox", 15_000, "inbox fetch");
    await delay(800);
    await takeShot("03-inbox");

    await sendKey("ENTER");
    await waitLog(walk, "Downloading screen presented", 15_000, "download screen");
    await takeShot("04-download");
    await waitLog(walk, "Downloading:", 15_000, "download start");

    await waitFor(() => {
      const found = findEpub(sd);
      return Boolean(found && existsSync(found) && readFileSync(found).length > 100);
    }, 30_000, "EPUB on SD");

    const afterDownload = simLogText(walk).length;
    await sendKey("BACK");
    await sendKey("BACK");
    await waitLog(walk, "Entering activity: Home", 15_000, "Home after download", afterDownload);
    await delay(400);
    await takeShot("05-home-after-download");

    await sendKey("UP");
    await sendKey("UP");
    await sendKey("ENTER");
    await waitLog(walk, "Entering activity: FileBrowser(?:\\r?\\n|$)", 15_000, "FileBrowser");
    await delay(400);
    await takeShot("06-files");

    await sendKey("ENTER");
    await waitLog(walk, "Entering activity: EpubReader", 20_000, "EpubReader");
    await delay(800);
    await takeShot("07-reader");

    await sendKey("QUIT");
    await walk.done;
    log("PASS simulator walk");
  } catch (error) {
    log(`FAIL simulator walk: ${error.message}`);
    walk.child.kill("SIGTERM");
    throw error;
  }

  const pngsByName = {};
  for (const name of SCREEN_NAMES) {
    const bmp = join(evidence, "screens", `${name}.bmp`);
    const png = join(evidence, "screens", `${name}.png`);
    if (!existsSync(bmp)) throw new Error(`screenshot missing ${name}.bmp`);
    bmpToPng(bmp, png);
    pngsByName[name] = readFileSync(png);
  }

  const downloaded = findEpub(sd);
  log("=== device harness (PR #12, wolfSSL + FatFs) ===");
  const harnessBuild = spawnLogged(
    join(here, "build-crossink-device.sh"),
    [],
    { ...process.env, PATH: env.PATH },
    join(evidence, "device-harness-build.log"),
    BUILD_DEADLINE_MS
  );
  const harnessOut = await harnessBuild.done;
  const harness = harnessOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("crossink-device-harness"))
    .at(-1);
  if (!harness || !existsSync(harness)) throw new Error(`device harness missing: ${harness || "(no path)"}`);
  const harnessRun = spawnLogged(
    harness,
    ["--url", catalogUrl, "--user", username, "--password", password, "--shelf", "Inbox", "--book-index", "0"],
    { ...process.env, PATH: env.PATH },
    join(evidence, "device-harness.log"),
    HARNESS_DEADLINE_MS
  );
  await harnessRun.done;

  const proof = assertWalkEvidence({
    simLog: simLogText(walk),
    pngsByName,
    epubPath: downloaded,
    harnessLog: readFileSync(join(evidence, "device-harness.log"), "utf8")
  });
  for (const [name, digest] of Object.entries(proof.hashes)) {
    log(`PASS screenshot ${name}.png sha256=${digest}`);
  }
  log(`PASS activity FileBrowser (exact) and EpubReader`);
  log(`PASS sd-epub ${proof.epub.path} bytes=${proof.epub.size} files=${proof.epub.files}`);
  log("PASS device harness download+validate");
  if (proof.jpegError4) {
    log("WARN JPEG err=4: fixture inline image did not decode in the simulator; reader text still opened");
  }

  const meta = {
    feature: "x3-simulator",
    crossink: { tag: CROSSINK_TAG, sha: CROSSINK_SHA, env: "simulator-X3" },
    catalog: { url: catalogUrl, username, fixture: !liveToken, liveToken },
    program,
    sd,
    evidence,
    screens: proof.hashes,
    jpegError4: proof.jpegError4,
    cannotReproduceIssue7: [
      "SDL UI is compiled with -DSIMULATOR and without FREEINK_NET_WOLFSSL",
      "HttpDownloader uses the curl shim (contentLength is the buffered body size)",
      "the SD free-space check is compiled out under SIMULATOR",
      "the wolfSSL + FatFs download proof is the device-harness step, not this UI"
    ],
    missing: [
      "ESP32 heap and fragmentation (host SDL process)",
      "wolfSSL record buffers inside the SDL sim",
      "real e-ink refresh / ghosting",
      "Wi-Fi association (simulator skips Wi-Fi and fetches immediately)"
    ]
  };
  writeFileSync(join(evidence, "meta.json"), JSON.stringify(meta, null, 2));
  log(`ALL PASS evidence=${evidence}`);
} finally {
  try {
    mkdirSync(artifactRoot, { recursive: true });
    const stamped = join(artifactRoot, `sim-x3-${runId}`);
    spawnSync("cp", ["-r", evidence, stamped]);
    const stable = join(artifactRoot, "sim-x3");
    spawnSync("rm", ["-rf", stable]);
    mkdirSync(stable, { recursive: true });
    spawnSync("cp", ["-r", `${evidence}/.`, stable]);
    log(`copied evidence to ${stamped} and ${stable}`);
  } catch (copyError) {
    log(`WARN could not copy artifacts: ${copyError.message}`);
  }
  if (catalog) await catalog.close();
  if (catalogProc && catalogProc.exitCode === null) catalogProc.kill("SIGTERM");
}
