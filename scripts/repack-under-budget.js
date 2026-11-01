import { basename } from "node:path";

import { strFromU8, unzipSync } from "fflate";

import { selectAssets } from "../src/core/budget.js";
import { buildEpub } from "../src/core/epub.js";
import { escapeXml } from "../src/core/xml.js";
import { toEpubJpeg } from "../src/shell/images.js";

export async function repackUnderBudget(bytes, { id, title, author }) {
  const entries = unzipSync(bytes);
  const chapter = strFromU8(entries["OEBPS/chapter.xhtml"]);
  const images = [];
  let cover = null;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".jpg")) continue;
    let jpeg = null;
    try {
      jpeg = await toEpubJpeg(data);
    } catch {
      jpeg = null;
    }
    if (!jpeg) continue;
    const href = name.replace(/^OEBPS\//, "");
    if (isCoverHref(href)) cover = { href, bytes: jpeg };
    else images.push({ href, bytes: jpeg });
  }

  const measure = (assets) => packed(chapter, id, title, author, assets).length;
  const chosen = selectAssets({ cover, images, measure });
  return packed(chapter, id, title, author, chosen);
}

function isCoverHref(href) {
  return basename(href).toLowerCase() === "cover.jpg";
}

function packed(chapter, id, title, author, { cover, images }) {
  const kept = new Set(images.map((image) => image.href));
  if (cover) kept.add(cover.href);
  return buildEpub({
    id,
    title,
    author,
    language: "en",
    modified: "2020-01-01T00:00:00Z",
    chapter: chapterKeeping(chapter, kept),
    images,
    cover
  });
}

// A skipped picture keeps its alt text. discover.jpg is not a cover.
function chapterKeeping(xhtml, hrefs) {
  let out = "";
  let cursor = 0;
  const lower = xhtml.toLowerCase();
  while (cursor < xhtml.length) {
    const start = lower.indexOf("<img", cursor);
    if (start < 0 || !isTagStart(xhtml, start)) {
      out += xhtml.slice(cursor);
      break;
    }
    const end = tagEnd(xhtml, start);
    out += xhtml.slice(cursor, start);
    const tag = xhtml.slice(start, end);
    const src = decodeXml(attr(tag, "src")).replace(/^\.\//, "");
    if (hrefs.has(src)) out += tag;
    else {
      const alt = decodeXml(attr(tag, "alt")).trim();
      if (alt) out += `<i>${escapeXml(alt)}</i>`;
    }
    cursor = end;
  }
  return out;
}

function isTagStart(xhtml, index) {
  const next = xhtml[index + 4];
  return next === undefined || /[\s>/]/.test(next);
}

function tagEnd(xhtml, start) {
  let quote = "";
  for (let i = start; i < xhtml.length; i++) {
    const char = xhtml[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i + 1;
  }
  return xhtml.length;
}

function attr(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Alt text counts whether the picture stayed (alt attribute) or was skipped
// (italic line). Comparing this is the "text unchanged" check.
export function visibleText(xhtml) {
  return replaceImgs(xhtml, (tag) => {
    const alt = decodeXml(attr(tag, "alt")).trim();
    return alt ? ` ${alt} ` : "";
  })
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function imgAltTexts(xhtml) {
  const alts = [];
  replaceImgs(xhtml, (tag) => {
    const alt = decodeXml(attr(tag, "alt")).trim();
    if (alt) alts.push(alt);
    return "";
  });
  return alts;
}

function replaceImgs(xhtml, replacement) {
  let out = "";
  let cursor = 0;
  const lower = xhtml.toLowerCase();
  while (cursor < xhtml.length) {
    const start = lower.indexOf("<img", cursor);
    if (start < 0 || !isTagStart(xhtml, start)) {
      out += xhtml.slice(cursor);
      break;
    }
    const end = tagEnd(xhtml, start);
    out += xhtml.slice(cursor, start);
    out += replacement(xhtml.slice(start, end));
    cursor = end;
  }
  return out;
}
