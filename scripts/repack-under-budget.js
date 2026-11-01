import { strFromU8, unzipSync } from "fflate";

import { selectAssets } from "../src/core/budget.js";
import { buildEpub } from "../src/core/epub.js";
import { toEpubJpeg } from "../src/shell/images.js";

export async function repackUnderBudget(bytes, { id, title, author }) {
  const entries = unzipSync(bytes);
  const chapter = strFromU8(entries["OEBPS/chapter.xhtml"]);
  const images = [];
  let cover = null;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".jpg")) continue;
    const jpeg = await toEpubJpeg(data);
    if (!jpeg) continue;
    const href = name.replace(/^OEBPS\//, "");
    if (href.endsWith("cover.jpg")) cover = { href, bytes: jpeg };
    else images.push({ href, bytes: jpeg });
  }

  const measure = (assets) => packed(chapter, id, title, author, assets).length;
  const chosen = selectAssets({ cover, images, measure });
  return packed(chapter, id, title, author, chosen);
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

function chapterKeeping(xhtml, hrefs) {
  return xhtml.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src="([^"]*)"/.exec(tag)?.[1] ?? "";
    const href = src.replace(/^\.\//, "");
    return hrefs.has(href) ? tag : "";
  });
}

export function visibleText(xhtml) {
  return xhtml
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
