// Article descriptions are HTML from whoever runs the feed. They're parsed into an inert
// document (DOMParser runs no scripts and loads nothing) and only an allowlist of elements
// and attributes is copied out; links must be http(s) or magnet links, images http(s) or
// small inline pictures. Addresses in the text become links.

const XHTML = "http://www.w3.org/1999/xhtml";

/** Left out along with everything in them. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input",
  "button", "select", "textarea", "option", "link", "meta", "base", "svg", "math", "noscript",
  "template", "audio", "video", "source", "track", "canvas", "dialog", "head", "title",
]);

/** Copied with these attributes. Other elements are replaced by what's in them. */
const ALLOWED: Record<string, readonly string[]> = {
  a: ["title"],
  img: ["alt", "title", "width", "height"],
  abbr: ["title"],
  ol: ["start"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
};
for (const tag of [
  "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "small", "sub", "sup",
  "mark", "code", "pre", "kbd", "samp", "q", "cite", "blockquote", "ul", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "div", "span", "section", "article", "header", "footer",
  "figure", "figcaption", "details", "summary", "table", "thead", "tbody", "tfoot", "tr", "caption",
]) ALLOWED[tag] ??= [];

const NUMERIC = new Set(["width", "height", "colspan", "rowspan", "start", "span"]);
const MAX_ATTR = 500;
const MAX_DEPTH = 64;
const MAX_DATA_IMAGE = 2 * 1024 * 1024;

const URL_RE = /\b(?:https?:\/\/|magnet:\?)[^\s<>"']+/gi;

function httpUrl(value: string, base: string | null): string | null {
  const v = value.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    if (!base) return null;
    try {
      u = new URL(v, base);
    } catch {
      return null;
    }
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}

function safeLink(value: string, base: string | null): string | null {
  const v = value.trim();
  if (/^magnet:\?/i.test(v)) return v;
  return httpUrl(v, base);
}

function safeImage(value: string, base: string | null): string | null {
  const v = value.trim();
  if (/^data:/i.test(v)) {
    return v.length <= MAX_DATA_IMAGE && /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i.test(v) ? v : null;
  }
  return httpUrl(v, base);
}

/** Leave off the punctuation that ends a sentence, and a ")" the address didn't open. */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (".,;:!?'\"]}*".includes(c)) {
      end--;
      continue;
    }
    if (c === ")") {
      const s = url.slice(0, end);
      if (s.split(")").length > s.split("(").length) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function linkTo(href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function linkify(text: string, to: Node): void {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const href = url && safeLink(url, null);
    if (!href) continue;
    const at = m.index ?? 0;
    if (at > last) to.appendChild(document.createTextNode(text.slice(last, at)));
    const a = linkTo(href);
    a.textContent = url;
    to.appendChild(a);
    last = at + url.length;
  }
  if (last < text.length) to.appendChild(document.createTextNode(last ? text.slice(last) : text));
}

/** The text of a subtree, without what's in dropped elements. */
function flatText(root: Element): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      return el.namespaceURI !== XHTML || DROP.has(el.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  let out = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out += n.nodeValue ?? "";
  return out;
}

function copyAttributes(from: Element, to: Element, names: readonly string[]): void {
  for (const name of names) {
    const raw = from.getAttribute(name);
    if (raw === null) continue;
    if (NUMERIC.has(name)) {
      const v = raw.trim();
      if (/^\d{1,4}$/.test(v)) to.setAttribute(name, v);
    } else to.setAttribute(name, raw.slice(0, MAX_ATTR));
  }
}

function copyChildren(from: Node, to: Node, base: string | null, depth: number, inLink: boolean): void {
  for (let n = from.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.nodeValue ?? "";
      if (inLink) to.appendChild(document.createTextNode(text));
      else linkify(text, to);
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue; // comments and the like
    const el = n as Element;
    const tag = el.localName;
    if (el.namespaceURI !== XHTML || DROP.has(tag)) continue;
    if (depth >= MAX_DEPTH) {
      const text = flatText(el);
      if (text) to.appendChild(document.createTextNode(text));
      continue;
    }
    const names = ALLOWED[tag];
    if (!names) {
      copyChildren(el, to, base, depth + 1, inLink);
      continue;
    }
    if (tag === "a") {
      const href = inLink ? null : safeLink(el.getAttribute("href") ?? "", base);
      if (!href) {
        copyChildren(el, to, base, depth + 1, inLink);
        continue;
      }
      const a = linkTo(href);
      copyAttributes(el, a, names);
      copyChildren(el, a, base, depth + 1, true);
      to.appendChild(a);
      continue;
    }
    if (tag === "img") {
      const src = safeImage(el.getAttribute("src") ?? "", base);
      if (!src) continue;
      const img = document.createElement("img");
      copyAttributes(el, img, names);
      // Before the address, so the request goes out with them.
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = src;
      to.appendChild(img);
      continue;
    }
    const out = document.createElement(tag);
    copyAttributes(el, out, names);
    copyChildren(el, out, base, depth + 1, inLink);
    to.appendChild(out);
  }
}

/**
 * An article's description, ready to put in the page. `base` resolves relative addresses
 * (the article's page, else the feed's address).
 */
export function renderDescription(source: string, base: string | null): DocumentFragment {
  const out = document.createDocumentFragment();
  const text = source.trim();
  if (!text) return out;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${text}`, "text/html");
  if (!/<[a-z!/?]/i.test(text)) {
    // Plain text (with its entities decoded): keep its line breaks.
    const div = document.createElement("div");
    div.className = "rss-plain";
    linkify(doc.body.textContent ?? "", div);
    out.appendChild(div);
    return out;
  }
  copyChildren(doc.body, out, base, 0, false);
  return out;
}

/** Where a link in a description goes: a torrent to add, a page to open, or nothing. */
export function linkTarget(href: string): { kind: "torrent" | "page"; url: string } | null {
  const v = href.trim();
  if (/^magnet:\?/i.test(v)) return { kind: "torrent", url: v };
  const url = httpUrl(v, null);
  if (!url) return null;
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* httpUrl parsed it */
  }
  return { kind: path.endsWith(".torrent") ? "torrent" : "page", url };
}
