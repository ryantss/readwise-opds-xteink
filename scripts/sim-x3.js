#!/usr/bin/env node
// Headless CrossInk v1.6.1 X3 simulator walk: local catalog on :8787, official
// PlatformIO native SDL binary (env:simulator-X3), scripted keys + screenshots,
// then the PR #12 device harness against the same catalog.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureCatalog } from "./fixture-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CROSSINK_TAG = "v1.6.1";
const CROSSINK_SHA = "9914146eeae7b46b300f475a16c32426fc02ec1f";
const DEFAULT_PORT = 8787;
const DEFAULT_USER = "ryan";
const DEFAULT_PASSWORD = "x3-sim-test";

const port = Number(process.env.SIM_X3_PORT || DEFAULT_PORT);
const username = process.env.OPDS_USERNAME || process.env.SIM_X3_USERNAME || DEFAULT_USER;
const password = process.env.OPDS_PASSWORD || process.env.SIM_X3_PASSWORD || DEFAULT_PASSWORD;
const liveToken = Boolean(process.env.READWISE_TOKEN);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = join(root, ".cache", "crossink-sim", "evidence", runId);
const artifactRoot = process.env.SIM_X3_ARTIFACTS || "/opt/cursor/artifacts";
mkdirSync(evidence, { recursive: true });
mkdirSync(join(evidence, "screens"), { recursive: true });

function log(line) {
  const text = `${line}\n`;
  process.stdout.write(text);
  writeFileSync(join(evidence, "sim-x3.log"), text, { flag: "a" });
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: root, ...opts });
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

function bmpToPng(bmpPath, pngPath) {
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required to convert simulator BMP screenshots");
  run(ffmpeg, ["-y", "-i", bmpPath, pngPath], { stdio: "ignore" });
}

function schedule(steps) {
  const inputs = [];
  const shots = [];
  for (const step of steps) {
    if (step.key) inputs.push(`${step.at}:${step.key}`);
    if (step.shot) shots.push(`${step.at}:${join(evidence, "screens", `${step.shot}.bmp`)}`);
  }
  return { input: inputs.join(";"), shots: shots.join(";") };
}

function spawnLogged(cmd, args, env, logFile) {
  const out = createWriteStream(logFile, { flags: "a" });
  const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => {
    out.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    out.write(chunk);
    process.stderr.write(chunk);
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${cmd} exited ${code}`), { status: code }));
    });
  });
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
    catalog = await startFixtureCatalog({ port, username, password });
    writeFileSync(join(evidence, "catalog.log"), `fixture ${catalog.baseUrl}/opds\n`);
  }

  const probe = await fetch(catalogUrl, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
  });
  if (probe.status !== 200) {
    throw new Error(`catalog ${catalogUrl} returned ${probe.status}`);
  }
  log(`PASS catalog ${catalogUrl} status=200`);

  log("=== build simulator-X3 ===");
  const built = run(join(here, "build-crossink-simulator.sh"));
  writeFileSync(join(evidence, "build.log"), built);
  const program = built.trim().split("\n").at(-1);
  if (!existsSync(program)) throw new Error(`simulator binary missing: ${program}`);
  log(`PASS build ${program}`);

  const sd = join(root, ".cache", "crossink-sim", "sd", runId);
  mkdirSync(sd, { recursive: true });
  seedOpds(sd, catalogUrl);
  log(`seeded ${sd}/.crosspoint/opds.json -> ${catalogUrl}`);

  // Home remembers OPDS Browser after return, so UP UP lands on Browse Files.
  // BACK during DOWNLOADING cancels the transfer; wait until the EPUB is on
  // disk. Home itself takes a couple of seconds after the second BACK.
  const walk = schedule([
    { at: 5000, shot: "01-home" },
    { at: 5500, key: "DOWN" },
    { at: 6000, key: "DOWN" },
    { at: 6500, key: "ENTER" },
    { at: 14000, shot: "02-catalog" },
    { at: 15000, key: "ENTER" },
    { at: 22000, shot: "03-inbox" },
    { at: 23000, key: "ENTER" },
    { at: 25000, shot: "04-download" },
    { at: 55000, key: "BACK" },
    { at: 57000, key: "BACK" },
    { at: 62000, shot: "05-home-after-download" },
    { at: 63000, key: "UP" },
    { at: 63500, key: "UP" },
    { at: 64000, key: "ENTER" },
    { at: 68000, shot: "06-files" },
    { at: 69000, key: "ENTER" },
    { at: 85000, shot: "07-reader" },
    { at: 88000, key: "QUIT" }
  ]);

  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH}`,
    CROSSPOINT_SIM_SD: sd,
    CROSSPOINT_SIM_INPUT_SCRIPT: walk.input,
    CROSSPOINT_SIM_SCREENSHOTS: walk.shots
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

  log("=== simulator walk ===");
  log(`INPUT ${walk.input}`);
  log(`SHOTS ${walk.shots}`);
  try {
    await spawnLogged(simArgs[0], simArgs.slice(1), env, join(evidence, "simulator.log"));
    log("PASS simulator walk");
  } catch (error) {
    log(`FAIL simulator walk: ${error.message}`);
    throw error;
  }

  const simLog = readFileSync(join(evidence, "simulator.log"), "utf8");
  for (const activity of ["OpdsBookBrowser", "FileBrowser", "Reader"]) {
    if (!simLog.includes(`Entering activity: ${activity}`)) {
      throw new Error(`simulator never entered ${activity}`);
    }
    log(`PASS activity ${activity}`);
  }

  const screens = [
    "01-home",
    "02-catalog",
    "03-inbox",
    "04-download",
    "05-home-after-download",
    "06-files",
    "07-reader"
  ];
  const missingScreens = [];
  for (const name of screens) {
    const bmp = join(evidence, "screens", `${name}.bmp`);
    const png = join(evidence, "screens", `${name}.png`);
    if (!existsSync(bmp)) {
      missingScreens.push(name);
      log(`FAIL screenshot missing ${name}.bmp`);
      continue;
    }
    bmpToPng(bmp, png);
    log(`PASS screenshot ${name}.png`);
  }
  if (missingScreens.length) {
    throw new Error(`missing screenshots: ${missingScreens.join(", ")}`);
  }

  const downloaded = run("find", [sd, "-name", "*.epub"], { encoding: "utf8" }).trim();
  if (!downloaded) throw new Error("no EPUB written to the simulated SD card");
  log(`PASS sd-epub ${downloaded}`);

  log("=== device harness (PR #12, wolfSSL + FatFs) ===");
  const harnessBuild = run(join(here, "build-crossink-device.sh"));
  const harness = harnessBuild.trim().split("\n").at(-1);
  await spawnLogged(
    harness,
    ["--url", catalogUrl, "--user", username, "--password", password, "--shelf", "Inbox", "--book-index", "0"],
    { ...process.env, PATH: env.PATH },
    join(evidence, "device-harness.log")
  );
  log("PASS device harness");

  const meta = {
    feature: "x3-simulator",
    crossink: { tag: CROSSINK_TAG, sha: CROSSINK_SHA, env: "simulator-X3" },
    catalog: { url: catalogUrl, username, fixture: !liveToken, liveToken },
    program,
    sd,
    evidence,
    missing: [
      "ESP32 heap and fragmentation (host SDL process)",
      "wolfSSL record buffers inside the SDL sim (that path uses host curl; wolfSSL is the device-harness step)",
      "real e-ink refresh / ghosting",
      "Wi-Fi association (simulator skips Wi-Fi and fetches immediately)"
    ]
  };
  writeFileSync(join(evidence, "meta.json"), JSON.stringify(meta, null, 2));
  log(`ALL PASS evidence=${evidence}`);
} finally {
  try {
    mkdirSync(artifactRoot, { recursive: true });
    run("cp", ["-r", evidence, join(artifactRoot, `sim-x3-${runId}`)]);
    log(`copied evidence to ${join(artifactRoot, `sim-x3-${runId}`)}`);
  } catch (copyError) {
    log(`WARN could not copy artifacts: ${copyError.message}`);
  }
  if (catalog) await catalog.close();
  if (catalogProc && catalogProc.exitCode === null) catalogProc.kill("SIGTERM");
}
