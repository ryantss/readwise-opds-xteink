// Assertions for the sim:x3 walk. A zero process exit is not a pass.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { unzipSync } from "fflate";

export const SCREEN_NAMES = [
  "01-home",
  "02-catalog",
  "03-inbox",
  "04-download",
  "05-home-after-download",
  "06-files",
  "07-reader"
];

export function enteredActivity(log, name) {
  return new RegExp(`Entering activity: ${name}(?:\\r?\\n|$)`).test(log);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function assertDistinctScreens(pngsByName) {
  const hashes = new Map();
  for (const [name, bytes] of Object.entries(pngsByName)) {
    if (!bytes || bytes.length < 32) {
      throw new Error(`screenshot ${name} is missing or empty`);
    }
    const digest = sha256(bytes);
    const prev = [...hashes.entries()].find(([, other]) => other === digest);
    if (prev) {
      throw new Error(`screenshots ${prev[0]} and ${name} are identical (${digest})`);
    }
    hashes.set(name, digest);
  }
  return Object.fromEntries(hashes);
}

export function assertActivities(simLog) {
  if (enteredActivity(simLog, "FileBrowserSettings") && !enteredActivity(simLog, "FileBrowser")) {
    throw new Error("log entered FileBrowserSettings but not FileBrowser");
  }
  for (const name of ["OpdsBookBrowser", "FileBrowser", "Reader", "EpubReader"]) {
    if (!enteredActivity(simLog, name)) {
      throw new Error(`simulator never entered ${name}`);
    }
  }
  if (!/Downloading screen presented/.test(simLog)) {
    throw new Error("simulator never presented the Downloading screen");
  }
}

export function assertValidEpub(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error("no EPUB written to the simulated SD card");
  }
  const size = statSync(filePath).size;
  if (size < 32) {
    throw new Error(`EPUB is too small (${size} bytes): ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`file is not a zip/EPUB (magic ${bytes.subarray(0, 4).toString("hex")}): ${filePath}`);
  }
  let files;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`EPUB zip is corrupt: ${error.message}`);
  }
  const names = Object.keys(files);
  if (!names.includes("META-INF/container.xml") && !names.includes("mimetype")) {
    throw new Error(`EPUB is missing container.xml/mimetype: ${names.join(", ") || "(empty zip)"}`);
  }
  const container = files["META-INF/container.xml"];
  if (!container || container.length === 0) {
    throw new Error("EPUB META-INF/container.xml is missing or empty");
  }
  return { path: filePath, size, files: names.length };
}

export function assertHarnessDownloaded(harnessLog) {
  if (!harnessLog.includes("ALL PASS")) {
    throw new Error("device harness log has no ALL PASS");
  }
  if (!harnessLog.includes("PASS step=download")) {
    throw new Error("device harness did not download");
  }
  if (!harnessLog.includes("PASS step=validate")) {
    throw new Error("device harness did not validate META-INF/container.xml");
  }
  if (harnessLog.includes("HARNESS_EXIT_WITHOUT_DOWNLOAD")) {
    throw new Error("device harness exited without downloading");
  }
}

export function jpegError4(simLog) {
  return /\[ERR\] \[JPG\] Failed to open JPEG \(err=4\)/.test(simLog);
}

export function assertWalkEvidence({ simLog, pngsByName, epubPath, harnessLog }) {
  assertActivities(simLog);
  const hashes = assertDistinctScreens(pngsByName);
  const epub = assertValidEpub(epubPath);
  assertHarnessDownloaded(harnessLog);
  return { hashes, epub, jpegError4: jpegError4(simLog) };
}
