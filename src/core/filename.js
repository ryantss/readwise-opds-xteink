// CrossInk writes the SD card name from the feed title (StringUtils::sanitizeFilename
// in v1.6.1), not Content-Disposition. The header still has to be short ASCII:
// SecureHttpClient::readLine rejects any header line >= 4096 bytes (MAX_LINE).
const FAT32_ILLEGAL = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);
const ASCII_STEM = /[^A-Za-z0-9._-]+/g;

export const CROSSINK_MAX_FILENAME_BYTES = 150;
export const CROSSINK_MAX_HEADER_LINE = 4096;

export function epubFilename(id) {
  const stem = String(id ?? "")
    .replace(ASCII_STEM, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "untitled"}.epub`;
}

export function contentDisposition(filename) {
  return `attachment; filename="${filename}"`;
}

export function isSafeAsciiFilename(filename) {
  if (!filename || filename.length > CROSSINK_MAX_FILENAME_BYTES) return false;
  for (const char of filename) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e || FAT32_ILLEGAL.has(char)) return false;
  }
  return true;
}

// Host-side port of CrossInk StringUtils::sanitizeFilename (v1.6.1).
export function sanitizeCrossInkFilename(name, maxBytes = CROSSINK_MAX_FILENAME_BYTES) {
  const trimmed = trimFilenameEdges(String(name ?? ""));
  const extensionStart = findSafeExtensionStart(trimmed);
  if (extensionStart !== -1) {
    const extension = trimmed.slice(extensionStart);
    if (extension.length < maxBytes) {
      const base = sanitizeFilenamePart(trimmed.slice(0, extensionStart), maxBytes - extension.length);
      if (base) return base + extension;
    }
  }
  return sanitizeFilenamePart(trimmed, maxBytes);
}

function trimFilenameEdges(name) {
  return name.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
}

function findSafeExtensionStart(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot + 1 >= name.length) return -1;
  const extension = name.slice(dot);
  if (extension.length > 16 || !/^\.[A-Za-z0-9]+$/.test(extension)) return -1;
  return dot;
}

function sanitizeFilenamePart(name, maxBytes) {
  let result = "";
  const text = name.replace(/^[\s.]+/, "");
  for (const char of text) {
    const code = char.codePointAt(0);
    if (FAT32_ILLEGAL.has(char)) {
      if (byteLength(result) + 1 > maxBytes) break;
      result += "_";
    } else if (code >= 128 || (code >= 32 && code < 127)) {
      const bytes = byteLength(char);
      if (byteLength(result) + bytes > maxBytes) break;
      result += char;
    }
  }
  result = result.replace(/[\s.]+$/, "");
  return result || "book";
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
