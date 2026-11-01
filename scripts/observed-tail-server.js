// HTTPS stand-in for the 1 Nov download. Content-Length stays 502491.
// /tail writes 458752 bytes and RSTs. /full-* sends the whole body, then
// keeps the socket, sends a TLS close_notify, or RSTs after the last byte.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";

import { OBSERVED_BODY_BYTES, OBSERVED_TAIL_STOP } from "../src/core/budget.js";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

// ZipFile scans the last 1KB for the EOCD signature, so a comment cannot
// make up a large gap. The pad is stored, and the search lands on an exact size.
export function buildObservedEpub(target = OBSERVED_BODY_BYTES) {
  const zipOf = (padLen) =>
    zipSync(
      {
        mimetype: [strToU8("application/epub+zip"), { level: 0 }],
        "META-INF/container.xml": strToU8(CONTAINER),
        "OEBPS/pad.bin": [new Uint8Array(padLen), { level: 0 }]
      },
      { level: 6 }
    );

  let lo = 0;
  let hi = target;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const zip = zipOf(mid);
    if (zip.length === target) return Buffer.from(zip);
    if (zip.length < target) {
      best = { pad: mid, zip };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) throw new Error(`no zip under ${target}`);
  const gap = target - best.zip.length;
  // One stored byte grows the zip by one, so the gap is 0. A leftover gap has
  // to stay inside the 1KB EOCD scan or ZipFile will not see the signature.
  if (gap === 0) return Buffer.from(best.zip);
  if (gap > 1000) throw new Error(`zip gap ${gap} is outside the 1KB EOCD scan`);
  return withShortComment(best.zip, gap);
}

function withShortComment(zip, commentLen) {
  const out = Buffer.alloc(zip.length + commentLen);
  out.set(zip);
  const eocd = zip.length - 22;
  if (out.readUInt32LE(eocd) !== 0x06054b50) throw new Error("EOCD signature missing");
  out.writeUInt16LE(commentLen, eocd + 20);
  out.fill(0x20, zip.length);
  return out;
}

function writeAll(res, chunk) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const step = 16 * 1024;
    const pump = () => {
      while (offset < chunk.length) {
        const end = Math.min(offset + step, chunk.length);
        const ok = res.write(chunk.subarray(offset, end));
        offset = end;
        if (!ok) {
          res.once("drain", pump);
          return;
        }
      }
      resolve();
    };
    pump();
    res.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startObservedTailServer() {
  const dir = mkdtempSync(join(tmpdir(), "observed-tail-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" }
  );
  const body = buildObservedEpub();
  if (body.length !== OBSERVED_BODY_BYTES) {
    throw new Error(`observed epub is ${body.length}, expected ${OBSERVED_BODY_BYTES}`);
  }

  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const mode = (req.url || "/").split("?")[0].replace(/^\//, "");
    const known = mode === "full-keepalive" || mode === "full-close" || mode === "full-rst" || mode === "tail";
    if (!known) {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
    }
    req.socket.setNoDelay(true);
    const connection = mode === "full-close" ? "close" : "keep-alive";
    const payload = mode === "tail" ? body.subarray(0, OBSERVED_TAIL_STOP) : body;
    res.writeHead(200, {
      "Content-Type": "application/epub+zip",
      "Content-Length": String(body.length),
      Connection: connection
    });
    writeAll(res, payload)
      .then(async () => {
        if (mode === "full-keepalive") {
          res.end();
          return;
        }
        if (mode === "full-close") {
          res.end();
          return;
        }
        // Drain, then give the client time to read the plaintext before the RST.
        // A RST that races the last record discards unread bytes.
        await wait(mode === "tail" ? 50 : 200);
        req.socket.resetAndDestroy();
      })
      .catch(() => {
        req.socket.destroy();
      });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    bodyLength: body.length,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
