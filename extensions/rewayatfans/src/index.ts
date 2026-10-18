import {
  absoluteUrl,
  parseHtml,
  sanitizeText,
  type Source,
  type SourceHost,
} from "@riwaq/extension-api";

const ID = "rewayatfans";
const BASE = "https://rewayatfans.com";

// رابط فصل يشبه: .../some-novel-59/ أو .../some-novel-20-2/
const CHAPTER_RE = /-\d+(-\d+)?\/?$/;

type Card = { url: string; title: string; coverUrl?: string };

function bestImg(img: Element | null): string | undefined {
  if (!img) return undefined;
  const src =
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("src");
  return src ? absoluteUrl(src, BASE) : undefined;
}

function parseCards(doc: Document): Card[] {
  const map = new Map<string, Card>();
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const url = absoluteUrl(a.getAttribute("href") ?? "", BASE);
    if (!url.startsWith(BASE + "/") || url === BASE + "/") continue;
    if (url.includes("/page/") || url.includes("?s=") || url.includes("#")) continue;

    const entry = map.get(url) ?? { url, title: "" };
    const img = a.querySelector("img");
    if (img) {
      entry.coverUrl ??= bestImg(img);
      if (!entry.title) entry.title = sanitizeText(img.getAttribute("alt") ?? "");
    }
    const text = sanitizeText(a.textContent ?? "");
    if (text && !img && text.length > 2) entry.title = entry.title || text;
    map.set(url, entry);
  }
  return [...map.values()].filter((c) => c.coverUrl && c.title);
}

function meta(doc: Document, prop: string): string {
  return doc.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ?? "";
}

export default function createSource(host: SourceHost): Source {
  async function load(url: string): Promise<Document> {
    const resp = await host.fetch(url);
    if (resp.status >= 400) throw new Error(`${ID}: HTTP ${resp.status} for ${url}`);
    return parseHtml(resp.text);
  }

  return {
    canHandle(url) {
      try {
        return new URL(url).hostname.replace(/^www\./, "") === "rewayatfans.com";
      } catch {
        return false;
      }
    },

    async getHomeSections() {
      host.log("info", `${ID}: home`);
      const doc = await load(BASE + "/");
      const cards = parseCards(doc);
      return [{ id: "latest", title: host.locale === "ar" ? "المضاف حديثاً" : "Latest", cards }];
    },

    async search(query, page = 1) {
      const q = query.trim();
      if (!q) return { cards: [], hasMore: false, query: "", page };
      host.log("info", `${ID}: search "${q}" p${page}`);
      const url =
        page > 1
          ? `${BASE}/page/${page}/?s=${encodeURIComponent(q)}`
          : `${BASE}/?s=${encodeURIComponent(q)}`;
      const doc = await load(url);
      const hasMore = !!doc.querySelector(
        `a.next, link[rel="next"], a[href*="/page/${page + 1}/"]`,
      );
      return { cards: parseCards(doc), hasMore, query: q, page };
    },

    async getNovel(url) {
      host.log("info", `${ID}: novel ${url}`);
      const doc = await load(url);

      const title =
        sanitizeText(doc.querySelector(".entry-title")?.textContent ?? "") ||
        sanitizeText(meta(doc, "og:title")).replace(/\s*[–-]\s*روايات فانز.*$/, "");

      const scope = doc.querySelector(".entry-content, article, main") ?? doc.body;
      const seen = new Set<string>();
      const chapters: { title: string; url: string }[] = [];
      for (const a of Array.from(scope.querySelectorAll("a[href]"))) {
        if (a.closest("#comments, header, footer, nav, aside")) continue;
        const href = absoluteUrl(a.getAttribute("href") ?? "", BASE);
        if (!href.startsWith(BASE + "/") || href === url || seen.has(href)) continue;
        if (!CHAPTER_RE.test(href)) continue;
        seen.add(href);
        chapters.push({
          title: sanitizeText(a.textContent ?? "") || href,
          url: href,
        });
      }
      const num = (u: string) => Number(u.match(/-(\d+)(?:-\d+)?\/?$/)?.[1] ?? 0);
      chapters.sort((x, y) => num(x.url) - num(y.url));

      return {
        title: title || "Untitled",
        author: "",
        language: "ar",
        direction: "rtl" as const,
        coverUrl: meta(doc, "og:image") || undefined,
        description: sanitizeText(meta(doc, "og:description")) || undefined,
        tags: [],
        meta: [],
        volumes: [
          {
            id: 1,
            title: host.locale === "ar" ? "الفصول" : "Chapters",
            chapters: chapters.map((c, i) => ({ id: i + 1, ...c, lines: [] })),
          },
        ],
      };
    },

    async getChapterContent(chapter) {
      host.log("debug", `${ID}: chapter ${chapter.url}`);
      const doc = await load(chapter.url);
      const body = doc.querySelector(".entry-content") ?? doc.querySelector("article");
      if (!body) throw new Error(`${ID}: chapter body not found for ${chapter.url}`);

      body
        .querySelectorAll("script, style, ins, iframe, .adsbygoogle, nav, .post-navigation")
        .forEach((el) => el.remove());

      const lines: { type: "text"; content: string }[] = [];
      for (const p of Array.from(body.querySelectorAll("p"))) {
        const text = sanitizeText(p.textContent ?? "");
        if (text) lines.push({ type: "text", content: text });
      }
      if (lines.length === 0) throw new Error(`${ID}: empty chapter ${chapter.url}`);
      return lines;
    },
  };
}
