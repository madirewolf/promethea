"""RSS feed reader and RSS auto-downloader (qBittorrent-compatible behaviour).

Everything here runs on the engine's asyncio loop. Network I/O is async; the
rest is plain, fast, synchronous code. Feed XML is parsed in a worker thread
(pure function) and bulk article saves are written from a worker thread, but
all state lives on the loop thread and ``emit`` is only ever called from it.

Storage layout inside ``data_dir``::

    feeds.json               feed list + folders
    rules.json               auto-download rules
    articles/<feedId>.json   articles of one feed (newest first)

The auto-downloader is a port of qBittorrent's ``AutoDownloader`` /
``AutoDownloadRule`` (src/base/rss/rss_autodownloader.cpp and
rss_autodownloadrule.cpp): wildcard / regex must-(not-)contain expressions,
the ``1x2;8-15;30-;`` episode filter, the smart episode filter with
REPACK/PROPER handling, "ignore subsequent matches for N days", and
processing of unread articles whenever rules change or auto-downloading is
switched on (qBittorrent's ``resetProcessingQueue``).
"""

from __future__ import annotations

import asyncio
import collections
import functools
import hashlib
import html
import html.entities
import inspect
import json
import logging
import re
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable
from urllib.parse import quote, urlsplit

import aiohttp

from .util import atomic_write_bytes, atomic_write_json, error_text, read_json

log = logging.getLogger("promethea.rss")

__all__ = [
    "RssManager",
    "parse_feed",
    "FeedParseError",
    "DEFAULT_SMART_FILTERS",
    "rule_matches",
    "normalize_rule",
    "detect_episode",
    "smart_episode_id",
    "matches_must_contain",
    "matches_must_not_contain",
    "matches_episode_filter",
]

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

USER_AGENT = "Promethea/0.1 (+libtorrent)"
ACCEPT = ("application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, "
          "application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8")
FETCH_TIMEOUT = 30.0            # seconds, whole request
MAX_FEED_BYTES = 10 * 1024 * 1024
MAX_CONCURRENT_FETCHES = 4
MAX_DESCRIPTION_CHARS = 20_000
MAX_TITLE_CHARS = 1_000

# qBittorrent's default "smart episode filter" expressions.
DEFAULT_SMART_FILTERS: list[str] = [
    r"s(\d+)e(\d+)",
    r"(\d+)x(\d+)",
    r"(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})",
    r"(\d{1,2}[.\-]\d{1,2}[.\-]\d{4})",
]

PREF_DEFAULTS: dict[str, Any] = {
    "fetchEnabled": True,
    "refreshInterval": 30,      # minutes
    "maxArticles": 50,          # per feed
    "autoDownload": False,
    "smartFilters": DEFAULT_SMART_FILTERS,
    "downloadRepacks": True,
}

CONTENT_LAYOUTS = {"original": "original", "subfolder": "subfolder", "nosubfolder": "noSubfolder",
                   "create_subfolder": "subfolder", "no_subfolder": "noSubfolder"}

_TORRENT_MIME = "application/x-bittorrent"
_NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

# --------------------------------------------------------------------------
# Small helpers: text, dates, URLs
# --------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"<(?:[A-Za-z/!?][^<>]*)>")
_LOOKS_HTML_RE = re.compile(r"<[A-Za-z/!]")
_DIGITS_RE = re.compile(r"[0-9]+")


def clean_text(value: str | None, limit: int = MAX_TITLE_CHARS) -> str:
    """Turn an HTML-ish title into plain single-line text."""
    if not value:
        return ""
    s = value
    if "<" in s and _LOOKS_HTML_RE.search(s):
        s = _TAG_RE.sub("", s)
    if "&" in s:
        s = html.unescape(s)
    s = _WS_RE.sub(" ", s).strip()
    return s[:limit]


def parse_date(value: str | None) -> int:
    """RFC 822 / ISO 8601 date -> unix seconds (0 if unknown/invalid)."""
    if not value:
        return 0
    s = value.strip()
    if not s:
        return 0
    dt: datetime | None = None
    iso_first = bool(re.match(r"^\d{4}-?\d{2}", s))
    for attempt in ((_parse_iso, _parse_rfc822) if iso_first else (_parse_rfc822, _parse_iso)):
        dt = attempt(s)
        if dt is not None:
            break
    if dt is None:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        ts = int(dt.timestamp())
    except (OverflowError, OSError, ValueError):
        return 0
    return ts if ts > 0 else 0


def _parse_rfc822(s: str) -> datetime | None:
    try:
        return parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def _parse_iso(s: str) -> datetime | None:
    t = s.strip()
    # Python's fromisoformat is strict about a few things feeds do loosely.
    t = re.sub(r"(?i)^(\d{4}-\d{2}-\d{2})[ t]", r"\1T", t)
    if t[-1:] in ("z", "Z"):
        t = t[:-1] + "+00:00"
    t = re.sub(r"\s*(?i:UTC|GMT)$", "+00:00", t)
    t = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", t) if re.search(r"T.*[+-]\d{4}$", t) else t
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        pass
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", t)
    if m:
        try:
            return datetime(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    return None


def normalize_feed_url(url: str) -> str:
    """Validate a feed URL; prepend http:// when the scheme is missing (like qBittorrent)."""
    u = (url or "").strip()
    if not u:
        raise ValueError("Type the feed's address")
    if "://" not in u:
        u = "http://" + u
    parts = urlsplit(u)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise ValueError("That isn't a web address (it should start with http:// or https://)")
    return u


def _is_torrent_like(url: str) -> bool:
    if not url:
        return False
    low = url.strip().lower()
    if low.startswith("magnet:"):
        return True
    if low.endswith(".torrent"):
        return True
    try:
        return urlsplit(low).path.endswith(".torrent")
    except ValueError:
        return False


def _norm_folder(path: str | None) -> str:
    if not path:
        return ""
    parts = [p.strip() for p in str(path).replace("\\", "/").split("/")]
    return "/".join(p for p in parts if p)


def _folder_ancestors(path: str) -> list[str]:
    parts = path.split("/") if path else []
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off", ""):
            return False
    return default


def _as_int(value: Any, default: int) -> int:
    if value is None or isinstance(value, bool):
        return default if value is None else int(value)
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _str_list(value: Any) -> list[str]:
    """Coerce to a de-duplicated list of non-empty strings (order kept)."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    out: list[str] = []
    seen: set[str] = set()
    try:
        items = list(value)
    except TypeError:
        return []
    for item in items:
        if item is None:
            continue
        s = str(item).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


# --------------------------------------------------------------------------
# Feed parsing (RSS 2.0, RSS 1.0/RDF, Atom 1.0/0.3, ezRSS torrent extension)
# --------------------------------------------------------------------------

class FeedParseError(Exception):
    """The downloaded document is not a usable RSS/Atom feed."""


@dataclass
class ParsedFeed:
    title: str
    articles: list[dict]   # feed order; keys: id,title,link,torrentUrl,description,date,author


def _local(tag: Any) -> str:
    if not isinstance(tag, str):
        return ""
    i = tag.rfind("}")
    return (tag[i + 1:] if i >= 0 else tag).lower()


def _ns(tag: Any) -> str:
    if isinstance(tag, str) and tag.startswith("{"):
        return tag[1:tag.find("}")]
    return ""


def _text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    if len(el):
        return "".join(el.itertext()).strip()
    return (el.text or "").strip()


def _attr(el: ET.Element, name: str) -> str:
    """Attribute lookup ignoring namespace and case."""
    v = el.get(name)
    if v is not None:
        return v.strip()
    lname = name.lower()
    for k, val in el.attrib.items():
        if _local(k) == lname:
            return (val or "").strip()
    return ""


class _Node:
    """Children of an element grouped by lower-case local name."""

    __slots__ = ("el", "ns", "kids")

    def __init__(self, el: ET.Element) -> None:
        self.el = el
        self.ns = _ns(el.tag)
        self.kids: dict[str, list[ET.Element]] = {}
        for child in el:
            self.kids.setdefault(_local(child.tag), []).append(child)

    def all(self, name: str) -> list[ET.Element]:
        return self.kids.get(name, [])

    def first(self, name: str, *, own_ns: bool = False) -> ET.Element | None:
        cands = self.kids.get(name)
        if not cands:
            return None
        for c in cands:
            if _ns(c.tag) == self.ns:
                return c
        return None if own_ns else cands[0]

    def text(self, *names: str) -> str:
        """First non-empty text among ``names`` (own namespace preferred)."""
        for name in names:
            cands = self.kids.get(name)
            if not cands:
                continue
            ordered = sorted(cands, key=lambda c: _ns(c.tag) != self.ns)
            for c in ordered:
                t = _text(c)
                if t:
                    return t
        return ""


def _inner_markup(el: ET.Element) -> str:
    """Serialize the children of an Atom type="xhtml" element (namespaces stripped)."""
    def strip(e: ET.Element) -> None:
        e.tag = _local(e.tag) or e.tag
        for k in list(e.attrib):
            if k.startswith("{"):
                e.attrib[_local(k)] = e.attrib.pop(k)
        for c in e:
            strip(c)

    parts = [html.escape(el.text or "", quote=False)]
    for child in el:
        c = ET.fromstring(ET.tostring(child))
        strip(c)
        c.tail = child.tail
        parts.append(ET.tostring(c, encoding="unicode", method="html"))
    return "".join(parts).strip()


def _atom_text(el: ET.Element | None, *, markup: bool = False) -> str:
    if el is None:
        return ""
    kind = _attr(el, "type").lower()
    if kind == "xhtml" or (len(el) and kind not in ("text", "html")):
        if markup:
            return _inner_markup(el)
        return "".join(el.itertext()).strip()
    return (el.text or "").strip()


_XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
_AMP_RE = re.compile(r"&(#[0-9]+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;?)?")
_BAD_XML_CHARS_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_CDATA_SPLIT_RE = re.compile(r"(<!\[CDATA\[.*?\]\]>|<!--.*?-->)", re.S)


def _valid_xml_char(cp: int) -> bool:
    return (cp in (0x9, 0xA, 0xD) or 0x20 <= cp <= 0xD7FF or 0xE000 <= cp <= 0xFFFD
            or 0x10000 <= cp <= 0x10FFFF)


def _fix_entity(m: re.Match) -> str:
    body = m.group(1)
    if body is None:
        return "&amp;"
    if body.startswith("#"):
        try:
            cp = int(body[2:-1], 16) if body[1] in "xX" else int(body[1:-1])
        except ValueError:
            return ""
        return m.group(0) if _valid_xml_char(cp) else ""
    if not body.endswith(";"):
        return "&amp;" + body
    name = body[:-1]
    if name in _XML_ENTITIES:
        return m.group(0)
    cp = html.entities.name2codepoint.get(name)
    if cp is None:
        cp = html.entities.name2codepoint.get(name.lower())
    return f"&#{cp};" if cp is not None else "&amp;" + body


def _sanitize_xml(text: str) -> str:
    """Repair common feed sloppiness: HTML entities, bare '&', control chars."""
    text = _BAD_XML_CHARS_RE.sub("", text)
    pieces = _CDATA_SPLIT_RE.split(text)
    for i in range(0, len(pieces), 2):  # even indexes are outside CDATA/comments
        pieces[i] = _AMP_RE.sub(_fix_entity, pieces[i])
    return "".join(pieces)


_XML_DECL_ENC_RE = re.compile(rb"^<\?xml[^>]*?encoding\s*=\s*[\"']([A-Za-z0-9._:\-]+)[\"']")


def _decode(data: bytes, encoding_hint: str | None) -> str:
    candidates: list[str] = []
    if data.startswith(b"\xef\xbb\xbf"):
        candidates.append("utf-8-sig")
    elif data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        candidates.append("utf-16")
    m = _XML_DECL_ENC_RE.match(data[:256])
    if m:
        candidates.append(m.group(1).decode("ascii", "ignore"))
    if encoding_hint:
        candidates.append(encoding_hint)
    candidates.append("utf-8")
    for enc in candidates:
        try:
            return data.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _parse_xml(data: bytes, encoding_hint: str | None) -> ET.Element:
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    data = data.lstrip(b" \t\r\n")
    if not data:
        raise FeedParseError("Empty response")
    first_error: Exception | None = None
    try:
        return ET.fromstring(data)
    except (ET.ParseError, ValueError, LookupError, UnicodeError) as e:
        first_error = e
    text = _decode(data, encoding_hint).lstrip("﻿ \t\r\n")
    try:
        return ET.fromstring(text)
    except (ET.ParseError, ValueError):
        pass
    try:
        return ET.fromstring(_sanitize_xml(text))
    except (ET.ParseError, ValueError):
        pass
    msg = str(first_error) if first_error else "unknown error"
    raise FeedParseError(f"Invalid XML: {msg}"[:200])


def _magnet_from_hash(info_hash: str, title: str) -> str:
    h = info_hash.strip()
    if re.fullmatch(r"[0-9a-fA-F]{40}", h) or re.fullmatch(r"[A-Za-z2-7]{32}", h):
        link = f"magnet:?xt=urn:btih:{h}"
        if title:
            link += "&dn=" + quote(title, safe="")
        return link
    return ""


def _find_desc(el: ET.Element, name: str, depth: int = 2) -> str:
    """Text of the first descendant (up to ``depth`` levels) with local ``name``."""
    level = [el]
    for _ in range(depth):
        nxt: list[ET.Element] = []
        for parent in level:
            for c in parent:
                if _local(c.tag) == name:
                    t = _text(c)
                    if t:
                        return t
                nxt.append(c)
        level = nxt
    return ""


def _pick_torrent_url(enclosures: list[tuple[str, str]], magnet_uri: str, link: str,
                      info_hash: str, title: str, link_is_page: bool = False) -> str:
    # 1. <enclosure type="application/x-bittorrent">
    for url, mime in enclosures:
        if url and mime.split(";")[0].strip().lower() == _TORRENT_MIME:
            return url
    # 2. any enclosure that is a .torrent / magnet
    for url, _mime in enclosures:
        if _is_torrent_like(url):
            return url
    # 3. ezRSS <torrent><magnetURI>
    if magnet_uri:
        return magnet_uri
    # 4. <link> if it is a magnet / .torrent
    if _is_torrent_like(link):
        return link
    # (extension) an explicit info-hash -> magnet link
    if info_hash:
        magnet = _magnet_from_hash(info_hash, title)
        if magnet:
            return magnet
    # 5. first enclosure, 6. the link - tracker feeds often put the download link there
    # (qBittorrent tries it too), unless the feed says it's a web page.
    for url, _mime in enclosures:
        if url:
            return url
    return "" if link_is_page else link


def _article_id(guid: str, link: str, title: str, date_raw: str) -> str:
    if guid:
        return guid
    if link:
        return link
    return "h:" + hashlib.sha1(f"{title}\x00{date_raw}".encode("utf-8", "replace")).hexdigest()[:32]


def _magnet_uri_of(el: ET.Element) -> str:
    uri = _find_desc(el, "magneturi")
    return uri if uri.lower().startswith("magnet:") else ""


def _parse_rss_item(el: ET.Element) -> dict | None:
    n = _Node(el)
    title = clean_text(n.text("title"))

    # <link> (RSS) - some feeds use an href attribute instead of text.
    link = ""
    for c in sorted(n.all("link"), key=lambda c: _ns(c.tag) != n.ns):
        link = _text(c) or _attr(c, "href")
        if link:
            break

    guid_el = n.first("guid")
    guid = _text(guid_el)
    if not guid:
        guid = _attr(el, f"{{{_NS_RDF}}}about") or _attr(el, "about")
    permalink = ""
    if guid_el is not None and guid.lower().startswith(("http://", "https://")):
        if _attr(guid_el, "isPermaLink").lower() != "false":
            permalink = guid

    enclosures: list[tuple[str, str]] = []
    for c in n.all("enclosure"):
        enclosures.append((_attr(c, "url") or _attr(c, "href"), _attr(c, "type")))
    for c in n.all("content"):  # Media RSS <media:content url type>
        url = _attr(c, "url")
        if url and (_attr(c, "type").lower().startswith(_TORRENT_MIME) or _is_torrent_like(url)):
            enclosures.append((url, _attr(c, "type")))

    torrent_url = _pick_torrent_url(enclosures, _magnet_uri_of(el), link,
                                    _find_desc(el, "infohash"), title)
    article_link = link
    if (not article_link or _is_torrent_like(article_link)) and permalink:
        article_link = permalink

    description = ""
    for c in n.all("encoded"):  # <content:encoded>
        description = _text(c)
        if description:
            break
    if not description:
        description = n.text("description", "summary")

    date_raw = n.text("pubdate", "date", "published", "updated", "issued", "modified")
    author = clean_text(n.text("author", "creator"), 300)

    if not (title or link or guid or torrent_url):
        return None
    return {
        "id": _article_id(guid, link, title, date_raw),
        "title": title,
        "link": article_link,
        "torrentUrl": torrent_url,
        "description": description[:MAX_DESCRIPTION_CHARS],
        "date": parse_date(date_raw),
        "author": author,
    }


def _parse_atom_entry(el: ET.Element) -> dict | None:
    n = _Node(el)
    title_el = n.first("title", own_ns=True)
    if title_el is None:
        title_el = n.first("title")
    title = clean_text(_atom_text(title_el))

    link = link_mime = ""
    enclosures: list[tuple[str, str]] = []
    alternates: list[tuple[str, str]] = []
    for c in n.all("link"):
        href = _attr(c, "href") or _text(c)
        if not href:
            continue
        rel = (_attr(c, "rel") or "alternate").lower()
        mime = _attr(c, "type")
        if rel == "enclosure" or mime.split(";")[0].strip().lower() == _TORRENT_MIME:
            enclosures.append((href, mime))
        elif rel == "alternate":
            alternates.append((href, mime.lower()))
    for href, mime in alternates:
        if "html" in mime:
            link, link_mime = href, mime
            break
    if not link and alternates:
        link, link_mime = alternates[0]

    guid = n.text("id")
    torrent_url = _pick_torrent_url(enclosures, _magnet_uri_of(el), link,
                                    _find_desc(el, "infohash"), title, link_is_page="html" in link_mime)

    description = (_atom_text(n.first("content"), markup=True)
                   or _atom_text(n.first("summary"), markup=True))
    date_raw = n.text("published", "issued", "updated", "modified", "date")

    author = ""
    author_el = n.first("author")
    if author_el is not None:
        author = _Node(author_el).text("name", "email") or _text(author_el)
    if not author:
        author = n.text("creator")

    if not (title or link or guid or torrent_url):
        return None
    return {
        "id": _article_id(guid, link, title, date_raw),
        "title": title,
        "link": link,
        "torrentUrl": torrent_url,
        "description": description[:MAX_DESCRIPTION_CHARS],
        "date": parse_date(date_raw),
        "author": clean_text(author, 300),
    }


def parse_feed(data: bytes, encoding_hint: str | None = None) -> ParsedFeed:
    """Parse an RSS 2.0 / RSS 1.0 (RDF) / Atom document.

    Pure function (safe to run in a worker thread). Raises FeedParseError.
    """
    root = _parse_xml(data, encoding_hint)
    kind = _local(root.tag)
    items: list[ET.Element] = []
    atom = False
    channel_title = ""

    if kind == "feed":
        atom = True
        rn = _Node(root)
        title_el = rn.first("title", own_ns=True)
        if title_el is None:
            title_el = rn.first("title")
        channel_title = clean_text(_atom_text(title_el))
        items = rn.all("entry")
    elif kind in ("rss", "rdf"):
        rn = _Node(root)
        channel = rn.first("channel")
        if channel is not None:
            cn = _Node(channel)
            channel_title = clean_text(cn.text("title"))
            items = cn.all("item")
        # RSS 1.0 puts items next to <channel>; some broken RSS 2.0 feeds do too.
        items = items + rn.all("item")
    elif kind == "channel":
        cn = _Node(root)
        channel_title = clean_text(cn.text("title"))
        items = cn.all("item")
    else:
        raise FeedParseError("Not an RSS or Atom feed")

    articles: list[dict] = []
    seen: set[str] = set()
    for item in items:
        try:
            art = _parse_atom_entry(item) if atom else _parse_rss_item(item)
        except Exception:  # one weird item must not kill the whole feed
            log.debug("Skipping unparsable feed item", exc_info=True)
            continue
        if art is None or art["id"] in seen:
            continue
        seen.add(art["id"])
        articles.append(art)
    return ParsedFeed(title=channel_title, articles=articles)


# --------------------------------------------------------------------------
# Auto-download rule matching (port of qBittorrent's AutoDownloadRule)
# --------------------------------------------------------------------------

def _qt_to_py_regex(pattern: str) -> str:
    """Translate the few PCRE/Qt regex spellings Python's ``re`` lacks."""
    p = re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", pattern)   # named group
    p = re.sub(r"\\k<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P=\1)", p)           # named backref
    p = re.sub(r"\\k\{([A-Za-z_][A-Za-z0-9_]*)\}", r"(?P=\1)", p)
    p = re.sub(r"(?<!\\)((?:\\\\)*)\\z", r"\1\\Z", p)                       # end of subject
    return p


@functools.lru_cache(maxsize=1024)
def _user_regex(pattern: str) -> re.Pattern | None:
    """Compile a user regex case-insensitively; None (and one warning) if invalid."""
    try:
        return re.compile(_qt_to_py_regex(pattern), re.IGNORECASE)
    except (re.error, RecursionError, OverflowError, ValueError) as e:
        log.warning("RSS rule: invalid regular expression %r (%s); the rule will not match", pattern, e)
        return None


@functools.lru_cache(maxsize=4096)
def _wildcard_regex(token: str) -> re.Pattern:
    """Wildcard token -> unanchored case-insensitive regex (`*` any run, `?` one char)."""
    token = re.sub(r"\*+", "*", token).strip("*")
    out: list[str] = []
    for ch in token:
        if ch == "*":
            out.append(".*")
        elif ch == "?":
            out.append(".")
        else:
            out.append(re.escape(ch))
    return re.compile("".join(out), re.IGNORECASE | re.DOTALL)


def _alternatives(expr: str, use_regex: bool) -> list[str]:
    # qBittorrent: regex mode keeps the whole string; wildcard mode splits on '|'.
    alts = [expr] if use_regex else expr.split("|")
    if len(alts) == 1 and alts[0] == "":
        return []  # no condition
    return alts


def _matches_expression(title: str, expression: str, use_regex: bool) -> bool:
    if not expression:
        return True  # "expr|" always matches (same as a regex alternation with an empty branch)
    if use_regex:
        rx = _user_regex(expression)
        return bool(rx is not None and rx.search(title))
    # Every whitespace-separated wildcard token must be present (order irrelevant).
    for token in expression.split():
        if not _wildcard_regex(token).search(title):
            return False
    return True


def matches_must_contain(title: str, expr: str, use_regex: bool = False) -> bool:
    alts = _alternatives(expr or "", use_regex)
    if not alts:
        return True
    if use_regex and _user_regex(alts[0]) is None:
        return False
    return any(_matches_expression(title, a, use_regex) for a in alts)


def matches_must_not_contain(title: str, expr: str, use_regex: bool = False) -> bool:
    """True when the title passes, i.e. contains none of the expressions."""
    alts = _alternatives(expr or "", use_regex)
    if not alts:
        return True
    if use_regex and _user_regex(alts[0]) is None:
        return False  # invalid regex: the rule never matches
    return not any(_matches_expression(title, a, use_regex) for a in alts)


# Season/episode detection in titles. SxxEyy (with multi-episode forms such as
# S01E01-E02, S01E01E02, S01E01-02) is preferred over NxM (1x05, 1x05-06).
_SE_RE = re.compile(
    r"(?:^|[^a-z0-9])s(\d{1,4})[ ._-]*e(\d{1,4})(?!\d)(?:-?e?(\d{1,4})(?![a-z0-9]))?", re.IGNORECASE)
_NX_RE = re.compile(
    r"(?:^|[^a-z0-9])(\d{1,4})x(\d{1,4})(?!\d)(?:-(\d{1,4})(?![a-z0-9]))?", re.IGNORECASE)


def _episode_list(first: str, last: str | None) -> list[int]:
    a = int(first)
    if last:
        b = int(last)
        if a < b <= a + 50:
            return list(range(a, b + 1))
    return [a]


def detect_episode(title: str) -> tuple[int, list[int]] | None:
    """Return (season, [episodes]) found in a title, or None."""
    m = _SE_RE.search(title)
    if m:
        return int(m.group(1)), _episode_list(m.group(2), m.group(3))
    for m in _NX_RE.finditer(title):
        season, episode = int(m.group(1)), int(m.group(2))
        if season >= 100 and episode >= 100:  # a video resolution such as 1920x1080
            continue
        return season, _episode_list(m.group(2), m.group(3))
    return None


_EP_FILTER_RE = re.compile(r"^\s*(\d{1,4})\s*x(.*;)\s*$", re.IGNORECASE | re.DOTALL)


@functools.lru_cache(maxsize=512)
def _parse_episode_filter(expr: str) -> tuple[int, tuple[tuple[int, int | None], ...]] | None:
    """'1x2;8-15;5;30-;' -> (1, ((2,2),(8,15),(5,5),(30,None))). None if invalid."""
    m = _EP_FILTER_RE.match(expr)
    if not m:
        return None
    season = int(m.group(1))
    tokens: list[tuple[int, int | None]] = []
    for raw in m.group(2).split(";"):
        tok = raw.strip()
        if not tok:
            continue
        if "-" in tok:
            lo_s, _, hi_s = tok.partition("-")
            lo_s, hi_s = lo_s.strip(), hi_s.strip()
            if not _DIGITS_RE.fullmatch(lo_s):
                continue
            if hi_s == "":
                tokens.append((int(lo_s), None))          # open range: this episode onwards
            elif _DIGITS_RE.fullmatch(hi_s):
                lo, hi = int(lo_s), int(hi_s)
                if lo <= hi:                               # qBittorrent ignores reversed ranges
                    tokens.append((lo, hi))
        elif _DIGITS_RE.fullmatch(tok):
            n = int(tok)
            tokens.append((n, n))
    return season, tuple(tokens)


def matches_episode_filter(title: str, expr: str) -> bool:
    expr = (expr or "").strip()
    if not expr:
        return True
    if not expr.endswith(";"):
        expr += ";"
    parsed = _parse_episode_filter(expr)
    if parsed is None:
        return False  # malformed filter never matches (qBittorrent)
    season_ours, tokens = parsed
    found = detect_episode(title)
    if found is None:
        return False
    season, episodes = found
    for lo, hi in tokens:
        if hi is None:
            # open range also accepts every later season (qBittorrent)
            if season > season_ours or (season == season_ours and any(e >= lo for e in episodes)):
                return True
        elif season == season_ours and any(lo <= e <= hi for e in episodes):
            return True
    return False


@functools.lru_cache(maxsize=64)
def _smart_regex(filters: tuple[str, ...]) -> re.Pattern | None:
    valid: list[str] = []
    for f in filters:
        p = _qt_to_py_regex(f)
        try:
            re.compile(p)
        except (re.error, RecursionError, OverflowError, ValueError) as e:
            log.warning("RSS smart episode filter %r is invalid (%s); ignoring it", f, e)
            continue
        valid.append(p)
    if not valid:
        return None
    # Same construction as qBittorrent's computeSmartFilterRegex().
    pattern = r"(?:_|\b)(?:" + ")|(?:".join(valid) + r")(?:_|\b)"
    try:
        return re.compile(pattern, re.IGNORECASE)
    except (re.error, RecursionError, OverflowError, ValueError) as e:
        log.warning("RSS smart episode filters cannot be combined (%s); smart filter disabled", e)
        return None


_RESOLUTION_HINT_RE = re.compile(r"\d\s*x\s*\d", re.IGNORECASE)
_REPACK_RE = re.compile(r"(?<![a-z0-9])repack(?![a-z0-9])", re.IGNORECASE)
_PROPER_RE = re.compile(r"(?<![a-z0-9])proper(?![a-z0-9])", re.IGNORECASE)


def _norm_capture(cap: str) -> str:
    cap = cap.strip()
    if _DIGITS_RE.fullmatch(cap):
        return str(int(cap))
    parts = re.split(r"[.\-/_ ]", cap)
    if len(parts) > 1 and all(_DIGITS_RE.fullmatch(p) for p in parts):
        return "-".join(f"{int(p):02d}" for p in parts)   # dates: 2023.10.5 -> 2023-10-05
    return cap


def smart_episode_id(title: str, filters: Iterable[str] | None = None) -> str:
    """Episode id like '1x5' or '2023-10-15' (qBittorrent's computeEpisodeName), '' if none."""
    rx = _smart_regex(tuple(DEFAULT_SMART_FILTERS if filters is None else filters))
    if rx is None:
        return ""
    for m in rx.finditer(title):
        caps = [c for c in m.groups() if c]
        if not caps:
            continue
        if (len(caps) == 2 and all(_DIGITS_RE.fullmatch(c) for c in caps)
                and int(caps[0]) >= 100 and int(caps[1]) >= 100
                and _RESOLUTION_HINT_RE.search(m.group(0))):
            continue  # 1920x1080 is a resolution, not an episode
        return "x".join(_norm_capture(c) for c in caps)
    return ""


def _smart_filter_check(title: str, history: Iterable[str], filters: Iterable[str] | None,
                        download_repacks: bool) -> tuple[bool, list[str]]:
    episode = smart_episode_id(title, filters)
    if not episode:
        return True, []
    is_repack = bool(_REPACK_RE.search(title))
    is_proper = bool(_PROPER_RE.search(title))
    full = episode + ("-REPACK" if is_repack else "") + ("-PROPER" if is_proper else "")
    extra = [episode + "-REPACK", episode + "-PROPER"] if (is_repack and is_proper) else []
    seen = set(history)
    if episode in seen:
        if not download_repacks or not (is_repack or is_proper):
            return False, []
        if full in seen:
            return False, []
        return True, [full, *extra]
    record = [episode]
    if is_repack or is_proper:
        # First sighting is already a repack/proper: don't take another one later.
        record += [full, *extra]
    return True, record


def rule_matches(rule: dict, title: str, *, smart_filters: Iterable[str] | None = None,
                 download_repacks: bool = True, now: float | None = None,
                 check_ignore_days: bool = True) -> tuple[bool, list[str]]:
    """qBittorrent's AutoDownloadRule::matches() for a (normalized) rule dict.

    Returns (matched, episode ids that would be added to previouslyMatchedEpisodes).
    Does not look at ``enabled`` or ``affectedFeeds``; never mutates the rule.
    """
    if check_ignore_days:
        ignore_days = _as_int(rule.get("ignoreDays"), 0)
        last_match = _as_int(rule.get("lastMatch"), 0)
        if ignore_days > 0 and last_match > 0:
            t = time.time() if now is None else now
            if t - last_match < ignore_days * 86400:
                return False, []
    use_regex = bool(rule.get("useRegex"))
    if not matches_must_contain(title, rule.get("mustContain") or "", use_regex):
        return False, []
    if not matches_must_not_contain(title, rule.get("mustNotContain") or "", use_regex):
        return False, []
    if not matches_episode_filter(title, rule.get("episodeFilter") or ""):
        return False, []
    if rule.get("smartFilter"):
        return _smart_filter_check(title, rule.get("previouslyMatchedEpisodes") or [],
                                   smart_filters, download_repacks)
    return True, []


def normalize_rule(raw: Any) -> dict:
    """Validate a rule dict and fill defaults. Raises ValueError on garbage."""
    if not isinstance(raw, dict):
        raise ValueError("Rule must be an object")
    episode_filter = str(raw.get("episodeFilter") or "").strip()
    if episode_filter and not episode_filter.endswith(";"):
        episode_filter += ";"
    layout = raw.get("contentLayout")
    layout = CONTENT_LAYOUTS.get(layout.strip().lower()) if isinstance(layout, str) else None
    add_paused = raw.get("addPaused")
    add_paused = None if add_paused is None else _as_bool(add_paused, None)  # type: ignore[arg-type]
    tags = raw.get("tags")
    if isinstance(tags, str):
        tags = tags.split(",")
    category = raw.get("category")
    if category is None:
        category = raw.get("assignedCategory")  # qBittorrent's field name
    last_match = raw.get("lastMatch")
    last_match = parse_date(last_match) if isinstance(last_match, str) and not last_match.strip().isdigit() \
        else _as_int(last_match, 0)
    return {
        "name": str(raw.get("name") or "").strip(),
        "enabled": _as_bool(raw.get("enabled"), True),
        "mustContain": str(raw.get("mustContain") or ""),
        "mustNotContain": str(raw.get("mustNotContain") or ""),
        "useRegex": _as_bool(raw.get("useRegex"), False),
        "episodeFilter": episode_filter,
        "smartFilter": _as_bool(raw.get("smartFilter"), False),
        "affectedFeeds": _str_list(raw.get("affectedFeeds")),
        "ignoreDays": max(0, _as_int(raw.get("ignoreDays"), 0)),
        "lastMatch": max(0, last_match),
        "previouslyMatchedEpisodes": _str_list(raw.get("previouslyMatchedEpisodes")),
        "addPaused": add_paused,
        "category": str(category or "").strip(),
        "tags": _str_list(tags),
        "savePath": str(raw.get("savePath") or "").strip(),
        "contentLayout": layout,
        "priority": _as_int(raw.get("priority"), 0),
    }


def _copy_rule(rule: dict) -> dict:
    out = dict(rule)
    for key in ("affectedFeeds", "previouslyMatchedEpisodes", "tags"):
        out[key] = list(rule.get(key) or [])
    return out


def _merge_lists(a: Iterable[str], b: Iterable[str]) -> list[str]:
    out = list(dict.fromkeys(a))
    seen = set(out)
    for item in b:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# --------------------------------------------------------------------------
# Manager
# --------------------------------------------------------------------------

class _FetchError(Exception):
    pass


def _describe_error(e: BaseException) -> str:
    """Short, user-facing message for a failed refresh."""
    if isinstance(e, (_FetchError, FeedParseError)):
        return str(e)[:200]
    if isinstance(e, TimeoutError):
        return "Timed out"
    if isinstance(e, aiohttp.TooManyRedirects):
        return "Too many redirects"
    if isinstance(e, aiohttp.InvalidURL):
        return "Invalid URL"
    if isinstance(e, aiohttp.ClientSSLError):
        return "SSL error"
    if isinstance(e, aiohttp.ClientConnectorError):
        return f"Cannot connect to {e.host}"
    if isinstance(e, aiohttp.ClientPayloadError):
        return "Download interrupted"
    if isinstance(e, aiohttp.ClientError):
        return f"Network error ({type(e).__name__})"
    if isinstance(e, OSError):
        return error_text(e)[:200]
    return f"{type(e).__name__}: {e}"[:200]


def _coerce_article(raw: Any) -> dict | None:
    if not isinstance(raw, dict):
        return None
    aid = raw.get("id")
    if not isinstance(aid, str) or not aid:
        return None
    return {
        "id": aid,
        "title": str(raw.get("title") or ""),
        "link": str(raw.get("link") or ""),
        "torrentUrl": str(raw.get("torrentUrl") or ""),
        "description": str(raw.get("description") or "")[:MAX_DESCRIPTION_CHARS],
        "date": max(0, _as_int(raw.get("date"), 0)),
        "read": _as_bool(raw.get("read"), False),
        "author": str(raw.get("author") or ""),
    }


@dataclass(eq=False)
class _Feed:
    id: str
    url: str
    custom_name: str | None = None
    folder: str = ""
    title: str = ""
    last_updated: int = 0
    loading: bool = False
    error: str | None = None
    articles: list[dict] = field(default_factory=list)       # newest first
    index: dict[str, dict] = field(default_factory=dict)     # id -> article

    @property
    def name(self) -> str:
        return self.custom_name or self.title or self.url

    def set_articles(self, articles: list[dict]) -> None:
        self.articles = articles
        self.index = {a["id"]: a for a in articles}

    def to_json(self) -> dict:
        return {"id": self.id, "url": self.url, "customName": self.custom_name,
                "folder": self.folder, "title": self.title, "lastUpdated": self.last_updated}


class RssManager:
    """RSS feeds + auto-downloader. See module docstring."""

    FIRST_REFRESH_DELAY = 5.0   # seconds between start() and the first refresh pass
    SAVE_DELAY = 3.0            # debounce for article/feed-state saves

    def __init__(self, data_dir: Path,
                 emit: Callable[[str, dict], None],
                 add_torrent: Callable[[str, dict], Awaitable[Any]],
                 get_prefs: Callable[[], dict]) -> None:
        self._dir = Path(data_dir)
        self._articles_dir = self._dir / "articles"
        self._feeds_path = self._dir / "feeds.json"
        self._rules_path = self._dir / "rules.json"
        self._emit_cb = emit
        self._add_torrent = add_torrent
        self._get_prefs = get_prefs

        self._feeds: dict[str, _Feed] = {}      # insertion ordered
        self._folders: set[str] = set()
        self._rules: dict[str, dict] = {}

        self._loaded = False
        self._started = False
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._last_pass: float | None = None
        self._applied: dict[str, Any] = dict(PREF_DEFAULTS)

        self._http: aiohttp.ClientSession | None = None
        self._fetch_sem = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
        self._inflight: dict[str, asyncio.Task] = {}    # feed id -> refresh task
        self._tasks: set[asyncio.Task] = set()          # other background tasks

        # auto-download processing queue (qBittorrent's m_processingQueue)
        self._queue: collections.deque[tuple[str, str]] = collections.deque()
        self._queued: set[tuple[str, str]] = set()
        self._worker: asyncio.Task | None = None

        # persistence
        self._dirty_articles: set[str] = set()
        self._feeds_dirty = False
        self._flush_handle: asyncio.TimerHandle | None = None
        self._flush_task: asyncio.Task | None = None

    # ------------------------------------------------------------ helpers

    def _emit(self, event: str, payload: dict) -> None:
        try:
            self._emit_cb(event, payload)
        except Exception:
            log.exception("RSS: emit(%s) failed", event)

    def _emit_feed(self, feed_id: str) -> None:
        self._emit("rss.feed", {"feedId": feed_id})

    def _prefs(self) -> dict[str, Any]:
        raw: Any = None
        try:
            prefs = self._get_prefs()
            raw = prefs.get("rss") if isinstance(prefs, dict) else None
        except Exception:
            log.exception("RSS: get_prefs() failed")
        if not isinstance(raw, dict):
            raw = {}
        filters = raw.get("smartFilters")
        if filters is None:
            filters = DEFAULT_SMART_FILTERS
        elif isinstance(filters, str):
            filters = filters.splitlines()
        try:
            filters = [str(f).strip() for f in filters if f is not None and str(f).strip()]
        except TypeError:
            filters = list(DEFAULT_SMART_FILTERS)
        return {
            "fetchEnabled": _as_bool(raw.get("fetchEnabled"), True),
            "refreshInterval": max(1, _as_int(raw.get("refreshInterval"), 30)),
            "maxArticles": max(1, _as_int(raw.get("maxArticles"), 50)),
            "autoDownload": _as_bool(raw.get("autoDownload"), False),
            "smartFilters": filters,
            "downloadRepacks": _as_bool(raw.get("downloadRepacks"), True),
        }

    @staticmethod
    def _running_loop() -> asyncio.AbstractEventLoop | None:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _spawn(self, coro: Awaitable[Any], name: str | None = None) -> asyncio.Task | None:
        loop = self._running_loop()
        if loop is None or self._closed:
            close = getattr(coro, "close", None)
            if close:
                close()
            return None
        task = loop.create_task(coro, name=name)  # type: ignore[arg-type]
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)
        return task

    def _on_task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("RSS background task %s failed", task.get_name(), exc_info=task.exception())

    async def _wait_idle(self, timeout: float = 60.0) -> None:
        """Wait for in-flight refreshes and auto-download work (used by tests)."""
        deadline = time.monotonic() + timeout
        while True:
            pending = [t for t in (*self._tasks, *self._inflight.values()) if not t.done()]
            if not pending:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("RSS manager did not become idle")
            await asyncio.wait(pending, timeout=remaining)

    def _new_feed_id(self) -> str:
        while True:
            fid = uuid.uuid4().hex[:12]
            if fid not in self._feeds:
                return fid

    def _feed_by_url(self, url: str) -> _Feed | None:
        for feed in self._feeds.values():
            if feed.url == url:
                return feed
        return None

    def _summary(self, f: _Feed) -> dict:
        return {
            "id": f.id,
            "name": f.name,
            "url": f.url,
            "folder": f.folder,
            "lastUpdated": f.last_updated,
            "loading": f.loading,
            "error": f.error,
            "unread": sum(1 for a in f.articles if not a["read"]),
            "total": len(f.articles),
            "title": f.title,
        }

    def _sorted_rules(self) -> list[dict]:
        return sorted(self._rules.values(), key=lambda r: (r["priority"], r["name"].lower(), r["name"]))

    # ------------------------------------------------------------ persistence

    def _load_state(self) -> tuple[list[_Feed], set[str], list[dict]]:
        """Read everything from disk. Touches no manager state (runs in a thread)."""
        feeds: list[_Feed] = []
        folders: set[str] = set()
        ids: set[str] = set()
        raw = read_json(self._feeds_path, None)
        feeds_ok = isinstance(raw, dict) and isinstance(raw.get("feeds"), list)
        if isinstance(raw, dict):
            for fr in raw.get("folders") or []:
                if isinstance(fr, str) and _norm_folder(fr):
                    folders.update(_folder_ancestors(_norm_folder(fr)))
            for fr in raw.get("feeds") or []:
                if not isinstance(fr, dict):
                    continue
                fid = str(fr.get("id") or "").strip()
                url = str(fr.get("url") or "").strip()
                if not fid or not url or fid in ids:
                    continue
                ids.add(fid)
                custom = fr.get("customName")
                feed = _Feed(id=fid, url=url,
                             custom_name=str(custom).strip() or None if custom else None,
                             folder=_norm_folder(fr.get("folder")),
                             title=str(fr.get("title") or ""),
                             last_updated=max(0, _as_int(fr.get("lastUpdated"), 0)))
                arts_raw = read_json(self._articles_dir / f"{fid}.json", None)
                if isinstance(arts_raw, dict):
                    arts_raw = arts_raw.get("articles")
                arts: list[dict] = []
                seen: set[str] = set()
                for a in arts_raw if isinstance(arts_raw, list) else []:
                    c = _coerce_article(a)
                    if c is not None and c["id"] not in seen:
                        seen.add(c["id"])
                        arts.append(c)
                arts.sort(key=lambda a: a["date"], reverse=True)
                feed.set_articles(arts)
                feeds.append(feed)
                folders.update(_folder_ancestors(feed.folder))
        if feeds_ok:
            # Article files of feeds that no longer exist (e.g. crash after a removal).
            try:
                if self._articles_dir.is_dir():
                    for p in self._articles_dir.glob("*.json"):
                        if p.stem not in ids:
                            p.unlink(missing_ok=True)
            except OSError:
                pass

        rules: list[dict] = []
        rraw = read_json(self._rules_path, None)
        items: Any = []
        if isinstance(rraw, dict):
            if isinstance(rraw.get("rules"), list):
                items = rraw["rules"]
            else:  # qBittorrent-style {name: rule}
                items = [dict(v, name=v.get("name") or k) for k, v in rraw.items() if isinstance(v, dict)]
        elif isinstance(rraw, list):
            items = rraw
        names: set[str] = set()
        for r in items:
            try:
                nr = normalize_rule(r)
            except ValueError:
                continue
            if nr["name"] and nr["name"] not in names:
                names.add(nr["name"])
                rules.append(nr)
        return feeds, folders, rules

    def _install_state(self, feeds: list[_Feed], folders: set[str], rules: list[dict]) -> None:
        if self._loaded:
            return
        self._loaded = True
        for f in feeds:
            self._feeds[f.id] = f
        self._folders |= folders
        for r in rules:
            self._rules[r["name"]] = r

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self._install_state(*self._load_state())

    def _save_feeds_now(self) -> None:
        self._feeds_dirty = False
        data = {"version": 1, "folders": sorted(self._folders),
                "feeds": [f.to_json() for f in self._feeds.values()]}
        try:
            atomic_write_json(self._feeds_path, data)
        except OSError:
            log.exception("RSS: failed to save %s", self._feeds_path)

    def _save_rules_now(self) -> None:
        data = {"version": 1, "rules": [_copy_rule(r) for r in self._sorted_rules()]}
        try:
            atomic_write_json(self._rules_path, data)
        except OSError:
            log.exception("RSS: failed to save %s", self._rules_path)

    def _articles_changed(self, feed_id: str) -> None:
        self._dirty_articles.add(feed_id)
        self._schedule_flush()

    def _feeds_changed_soft(self) -> None:
        """Feed state that may be saved lazily (title, lastUpdated)."""
        self._feeds_dirty = True
        self._schedule_flush()

    def _schedule_flush(self) -> None:
        if self._flush_handle is not None or self._closed:
            return
        loop = self._running_loop()
        if loop is None:
            self._flush_sync()
            return
        self._flush_handle = loop.call_later(self.SAVE_DELAY, self._on_flush_timer)

    def _on_flush_timer(self) -> None:
        self._flush_handle = None
        if self._flush_task is not None and not self._flush_task.done():
            self._schedule_flush()  # previous write still running; try again later
            return
        loop = self._running_loop()
        if loop is not None:
            self._flush_task = loop.create_task(self._flush_async(), name="promethea-rss-save")

    def _take_article_jobs(self) -> list[tuple[Path, bytes | None]]:
        jobs: list[tuple[Path, bytes | None]] = []
        for fid in self._dirty_articles:
            path = self._articles_dir / f"{fid}.json"
            feed = self._feeds.get(fid)
            if feed is None:
                jobs.append((path, None))  # feed removed -> delete its file
            else:
                payload = {"version": 1, "articles": feed.articles}
                jobs.append((path, json.dumps(payload, ensure_ascii=False,
                                              separators=(",", ":")).encode("utf-8")))
        self._dirty_articles.clear()
        return jobs

    @staticmethod
    def _write_jobs(jobs: list[tuple[Path, bytes | None]]) -> None:
        for path, data in jobs:
            try:
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_write_bytes(path, data)
            except OSError:
                log.exception("RSS: failed to write %s", path)

    async def _flush_async(self) -> None:
        if self._feeds_dirty:
            self._save_feeds_now()
        jobs = self._take_article_jobs()
        if jobs:
            await asyncio.to_thread(self._write_jobs, jobs)

    def _flush_sync(self) -> None:
        if self._feeds_dirty:
            self._save_feeds_now()
        jobs = self._take_article_jobs()
        if jobs:
            self._write_jobs(jobs)

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Load state from disk and start the periodic refresh loop."""
        if self._started or self._closed:
            return
        self._loop = asyncio.get_running_loop()
        if not self._loaded:
            state = await asyncio.to_thread(self._load_state)
            self._install_state(*state)
        self._applied = self._prefs()
        self._started = True
        self._loop_task = self._loop.create_task(self._refresh_loop(), name="promethea-rss-refresh-loop")
        self._emit("rss.feeds", {})
        self._emit("rss.rules", {})

    async def close(self) -> None:
        """Stop background work, flush pending saves and close the HTTP session."""
        if self._closed:
            return
        self._closed = True
        pending: list[asyncio.Task] = []
        if self._loop_task is not None:
            self._loop_task.cancel()
            pending.append(self._loop_task)
        for t in [*self._inflight.values(), *self._tasks]:
            t.cancel()
            pending.append(t)
        self._queue.clear()
        self._queued.clear()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self._flush_handle is not None:
            self._flush_handle.cancel()
            self._flush_handle = None
        if self._flush_task is not None and not self._flush_task.done():
            try:
                await self._flush_task
            except Exception:
                log.exception("RSS: save failed during close")
        if self._loaded:
            for f in self._feeds.values():
                f.loading = False
            self._feeds_dirty = True
            self._flush_sync()
        if self._http is not None:
            try:
                await self._http.close()
            except Exception:
                log.debug("RSS: error closing HTTP session", exc_info=True)
            self._http = None

    def apply_prefs(self) -> None:
        """Re-read prefs (refresh interval / enable flags / limits may have changed)."""
        self._ensure_loaded()
        new = self._prefs()
        old = self._applied
        self._applied = new
        if new["fetchEnabled"] and not old["fetchEnabled"]:
            self._last_pass = None  # refresh right away, like qBittorrent
        if (new["fetchEnabled"] != old["fetchEnabled"]
                or new["refreshInterval"] != old["refreshInterval"]):
            self._wake.set()
        limit = new["maxArticles"]
        for feed in self._feeds.values():
            if len(feed.articles) > limit:
                feed.set_articles(feed.articles[:limit])
                self._articles_changed(feed.id)
                self._emit_feed(feed.id)
        if new["autoDownload"] and not old["autoDownload"]:
            self._reset_processing()
        elif not new["autoDownload"]:
            self._queue.clear()
            self._queued.clear()

    async def _refresh_loop(self) -> None:
        try:
            await asyncio.sleep(self.FIRST_REFRESH_DELAY)
            # qBittorrent processes all unread articles when the auto-downloader starts.
            self._reset_processing()
            while not self._closed:
                self._wake.clear()
                timeout: float | None = None
                try:
                    prefs = self._prefs()
                    if prefs["fetchEnabled"]:
                        interval = prefs["refreshInterval"] * 60.0
                        if self._last_pass is None or time.monotonic() - self._last_pass >= interval:
                            self._last_pass = time.monotonic()
                            await self.refresh(None)
                        timeout = max(1.0, self._last_pass + interval - time.monotonic())
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("RSS: refresh loop error")
                    timeout = 60.0
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout)
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------ feeds API

    def snapshot(self) -> dict:
        self._ensure_loaded()
        return {"feeds": [self._summary(f) for f in self._feeds.values()],
                "folders": sorted(self._folders)}

    async def add_feed(self, url: str, name: str | None = None, folder: str = "") -> dict:
        """Add a feed and run its first refresh (when fetching is enabled).

        Raises ValueError for an invalid or duplicate URL.
        """
        self._ensure_loaded()
        url = normalize_feed_url(url)
        if self._feed_by_url(url) is not None:
            raise ValueError("You have this feed already")
        folder = _norm_folder(folder)
        feed = _Feed(id=self._new_feed_id(), url=url,
                     custom_name=(str(name).strip() or None) if name else None, folder=folder)
        self._feeds[feed.id] = feed
        self._folders.update(_folder_ancestors(folder))
        self._save_feeds_now()
        self._emit("rss.feeds", {})
        if self._prefs()["fetchEnabled"] and not self._closed:
            task = self._refresh_task(feed)
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if not task.cancelled():
                    raise  # we were cancelled; the refresh carries on
            except Exception:
                pass
        return self._summary(feed)

    def remove_feeds(self, feed_ids: list[str]) -> None:
        self._ensure_loaded()
        if isinstance(feed_ids, str):
            feed_ids = [feed_ids]
        removed = False
        for fid in dict.fromkeys(feed_ids or []):
            if self._feeds.pop(fid, None) is None:
                continue
            removed = True
            self._cancel_refresh(fid)
            self._articles_changed(fid)  # the next save deletes articles/<fid>.json
        if removed:
            self._save_feeds_now()
            self._emit("rss.feeds", {})

    def update_feed(self, feed_id: str, *, name: str | None = None, url: str | None = None,
                    folder: str | None = None) -> dict:
        """Rename / change URL / move a feed. KeyError if unknown, ValueError for a bad URL."""
        self._ensure_loaded()
        feed = self._feeds.get(feed_id)
        if feed is None:
            raise KeyError(feed_id)
        new_url = normalize_feed_url(url) if url is not None else feed.url
        if new_url != feed.url:
            other = self._feed_by_url(new_url)
            if other is not None and other is not feed:
                raise ValueError("You have this feed already")
        refetch = False
        if new_url != feed.url:
            old_url = feed.url
            feed.url = new_url
            feed.error = None
            self._cancel_refresh(feed.id)
            feed.loading = False
            self._replace_rule_feed_url(old_url, new_url)
            refetch = True
        if name is not None:
            feed.custom_name = str(name).strip() or None
        if folder is not None:
            feed.folder = _norm_folder(folder)
            self._folders.update(_folder_ancestors(feed.folder))
        self._save_feeds_now()
        self._emit("rss.feeds", {})
        if refetch and not self._closed and self._prefs()["fetchEnabled"]:
            self._spawn(self.refresh([feed.id]), name="promethea-rss-refetch")
        return self._summary(feed)

    def add_folder(self, path: str) -> None:
        self._ensure_loaded()
        p = _norm_folder(path)
        if not p:
            raise ValueError("Folder name is empty")
        before = len(self._folders)
        self._folders.update(_folder_ancestors(p))
        if len(self._folders) != before:
            self._save_feeds_now()
            self._emit("rss.feeds", {})

    def remove_folder(self, path: str) -> None:
        """Remove a folder, its sub-folders and every feed inside them."""
        self._ensure_loaded()
        p = _norm_folder(path)
        if not p:
            raise ValueError("Cannot remove the root folder")

        def inside(f: str) -> bool:
            return f == p or f.startswith(p + "/")

        doomed_feeds = [fid for fid, f in self._feeds.items() if inside(f.folder)]
        doomed_folders = {f for f in self._folders if inside(f)}
        if not doomed_feeds and not doomed_folders:
            return
        self._folders -= doomed_folders
        for fid in doomed_feeds:
            del self._feeds[fid]
            self._cancel_refresh(fid)
            self._articles_changed(fid)
        self._save_feeds_now()
        self._emit("rss.feeds", {})

    def rename_folder(self, path: str, new_path: str) -> None:
        """Rename or move a folder, taking its sub-folders and feeds along."""
        self._ensure_loaded()
        old = _norm_folder(path)
        new = _norm_folder(new_path)
        if not old:
            raise ValueError("Cannot rename the root folder")
        if not new:
            raise ValueError("Folder name is empty")
        if old not in self._folders:
            raise KeyError(old)
        if new == old:
            return
        if new.startswith(old + "/"):
            raise ValueError("A folder can't go inside itself")
        if new in self._folders:
            raise ValueError(f"There's already a folder called “{new.rsplit('/', 1)[-1]}” there")

        def moved(f: str) -> str | None:
            if f == old:
                return new
            if f.startswith(old + "/"):
                return new + f[len(old):]
            return None

        self._folders = {moved(f) or f for f in self._folders}
        self._folders.update(_folder_ancestors(new))
        for feed in self._feeds.values():
            m = moved(feed.folder)
            if m is not None:
                feed.folder = m
        self._save_feeds_now()
        self._emit("rss.feeds", {})

    def articles(self, feed_id: str) -> list[dict]:
        """Copies of the feed's articles, newest first. KeyError if unknown."""
        self._ensure_loaded()
        feed = self._feeds.get(feed_id)
        if feed is None:
            raise KeyError(feed_id)
        return [dict(a) for a in feed.articles]

    def articles_by_feed(self, feed_ids: list[str] | None = None) -> dict[str, list[dict]]:
        """articles() of several feeds at once (None = all), by feed id. Unknown ids are skipped."""
        self._ensure_loaded()
        return {f.id: [dict(a) for a in f.articles] for f in self._pick_feeds(feed_ids)}

    def mark_all_read(self, feed_ids: list[str] | None = None) -> None:
        """mark_read() for every article of several feeds (None = all)."""
        self._ensure_loaded()
        for feed in self._pick_feeds(feed_ids):
            self.mark_read(feed.id)

    def _pick_feeds(self, feed_ids: list[str] | str | None) -> list[_Feed]:
        if feed_ids is None:
            return list(self._feeds.values())
        if isinstance(feed_ids, str):
            feed_ids = [feed_ids]
        return [self._feeds[i] for i in dict.fromkeys(feed_ids) if i in self._feeds]

    def mark_read(self, feed_id: str, article_ids: list[str] | None = None) -> None:
        self._ensure_loaded()
        feed = self._feeds.get(feed_id)
        if feed is None:
            raise KeyError(feed_id)
        if article_ids is None:
            targets = feed.articles
        else:
            if isinstance(article_ids, str):
                article_ids = [article_ids]
            targets = [feed.index[i] for i in dict.fromkeys(article_ids) if i in feed.index]
        changed = False
        for art in targets:
            if not art["read"]:
                art["read"] = True
                changed = True
        if changed:
            self._articles_changed(feed.id)
            self._emit_feed(feed.id)

    async def refresh(self, feed_ids: list[str] | None = None) -> None:
        """Fetch the given feeds (None = all) and wait until they are done."""
        self._ensure_loaded()
        if self._closed:
            return
        tasks = [self._refresh_task(f) for f in self._pick_feeds(feed_ids)]
        if tasks:
            await asyncio.gather(*(asyncio.shield(t) for t in tasks), return_exceptions=True)

    # ------------------------------------------------------------ refresh internals

    def _cancel_refresh(self, feed_id: str) -> None:
        task = self._inflight.pop(feed_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _refresh_task(self, feed: _Feed) -> asyncio.Task:
        task = self._inflight.get(feed.id)
        if task is not None and not task.done():
            return task  # already refreshing: share it
        task = asyncio.get_running_loop().create_task(self._refresh_one(feed),
                                                      name=f"promethea-rss-refresh-{feed.id}")
        self._inflight[feed.id] = task

        def _done(t: asyncio.Task, fid: str = feed.id) -> None:
            if self._inflight.get(fid) is t:
                del self._inflight[fid]

        task.add_done_callback(_done)
        return task

    def _http_session(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT),
                headers={"User-Agent": USER_AGENT},
                auto_decompress=True,
            )
        return self._http

    async def _fetch(self, url: str) -> tuple[bytes, str | None]:
        session = self._http_session()
        async with session.get(url, headers={"Accept": ACCEPT}, allow_redirects=True) as resp:
            if resp.status >= 400:
                raise _FetchError(f"HTTP {resp.status} {resp.reason or ''}".strip())
            if resp.content_length is not None and resp.content_length > MAX_FEED_BYTES:
                raise _FetchError("Feed is too large (over 10 MB)")
            buf = bytearray()
            async for chunk in resp.content.iter_chunked(64 * 1024):
                buf += chunk
                if len(buf) > MAX_FEED_BYTES:
                    raise _FetchError("Feed is too large (over 10 MB)")
            return bytes(buf), resp.charset

    async def _refresh_one(self, feed: _Feed) -> None:
        me = asyncio.current_task()
        url = feed.url
        feed.loading = True
        self._emit_feed(feed.id)
        try:
            try:
                async with self._fetch_sem:
                    data, charset = await self._fetch(url)
                parsed = await asyncio.to_thread(parse_feed, data, charset)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._feeds.get(feed.id) is feed and feed.url == url:
                    feed.error = _describe_error(e)
                    # By name: tracker feed addresses carry passkeys.
                    log.info("RSS: refreshing %r failed: %s", feed.name, feed.error)
                return
            if self._feeds.get(feed.id) is not feed or feed.url != url:
                return  # removed or re-pointed while we were fetching
            self._apply_parsed(feed, parsed)
        finally:
            current = self._inflight.get(feed.id)
            if current is None or current is me:
                feed.loading = False
                if self._feeds.get(feed.id) is feed and not self._closed:
                    self._emit_feed(feed.id)

    def _apply_parsed(self, feed: _Feed, parsed: ParsedFeed) -> None:
        prefs = self._prefs()
        old_name = feed.name
        if parsed.title:
            feed.title = parsed.title
        feed.error = None
        feed.last_updated = int(time.time())
        added, changed = self._merge_articles(feed, parsed.articles, prefs["maxArticles"])
        self._feeds_changed_soft()
        if changed:
            self._articles_changed(feed.id)
        if feed.name != old_name:
            self._emit("rss.feeds", {})
        if added and prefs["autoDownload"]:
            # qBittorrent announces new articles oldest first; queue them in that order.
            self._enqueue((feed.id, a["id"]) for a in reversed(added)
                          if not a["read"] and a["torrentUrl"])

    @staticmethod
    def _merge_articles(feed: _Feed, parsed: list[dict], max_articles: int) -> tuple[list[dict], bool]:
        """Port of qBittorrent's Feed::updateArticles(). Returns (new articles kept, changed)."""
        dummy_date = int(time.time())
        new: list[dict] = []
        for art in parsed:
            existing = feed.index.get(art["id"])
            if existing is not None:
                # Undated articles that follow a known one must sort below it.
                dummy_date = max(0, existing["date"] - 1)
                continue
            a = dict(art)
            if not a.get("date"):
                a["date"] = dummy_date
            a["read"] = False
            new.append(a)
        if not new and len(feed.articles) <= max_articles:
            return [], False
        combined = new + feed.articles
        combined.sort(key=lambda a: a["date"], reverse=True)  # stable: feed order kept on ties
        kept = combined[:max_articles]
        new_ids = {id(a) for a in new}
        added = [a for a in kept if id(a) in new_ids]
        if not added and len(kept) == len(feed.articles):
            return [], False
        feed.set_articles(kept)
        return added, True

    # ------------------------------------------------------------ rules API

    def rules(self) -> list[dict]:
        self._ensure_loaded()
        return [_copy_rule(r) for r in self._sorted_rules()]

    def set_rule(self, rule: dict) -> dict:
        """Create or replace a rule by name; returns the normalized rule.

        lastMatch / previouslyMatchedEpisodes of an existing rule are kept (merged), so a
        stale copy sent back by the UI cannot erase matching history; use
        clear_episode_history() to reset it.
        """
        self._ensure_loaded()
        new = normalize_rule(rule)
        if not new["name"]:
            raise ValueError("Rule name is empty")
        old = self._rules.get(new["name"])
        if old is not None:
            new["lastMatch"] = max(new["lastMatch"], old["lastMatch"])
            new["previouslyMatchedEpisodes"] = _merge_lists(old["previouslyMatchedEpisodes"],
                                                            new["previouslyMatchedEpisodes"])
            if new == old:
                return _copy_rule(old)
        self._rules[new["name"]] = new
        self._save_rules_now()
        self._emit("rss.rules", {})
        self._reset_processing()  # qBittorrent re-checks unread articles when rules change
        return _copy_rule(new)

    def rename_rule(self, old: str, new: str) -> None:
        self._ensure_loaded()
        if old not in self._rules:
            raise KeyError(old)
        new_name = str(new or "").strip()
        if not new_name:
            raise ValueError("Rule name is empty")
        if new_name == old:
            return
        if new_name in self._rules:
            raise ValueError(f"There's already a rule called “{new_name}”")
        rule = self._rules.pop(old)
        rule["name"] = new_name
        self._rules[new_name] = rule
        self._save_rules_now()
        self._emit("rss.rules", {})

    def delete_rules(self, names: list[str]) -> None:
        self._ensure_loaded()
        if isinstance(names, str):
            names = [names]
        removed = [n for n in dict.fromkeys(names or []) if self._rules.pop(n, None) is not None]
        if removed:
            self._save_rules_now()
            self._emit("rss.rules", {})

    def preview_rule(self, rule: dict) -> list[dict]:
        """Articles of the rule's feeds that it matches now (read ones included, like qBittorrent)."""
        self._ensure_loaded()
        r = normalize_rule(rule)
        stored = self._rules.get(r["name"])
        if stored is not None:
            if "lastMatch" not in rule:
                r["lastMatch"] = stored["lastMatch"]
            if "previouslyMatchedEpisodes" not in rule:
                r["previouslyMatchedEpisodes"] = list(stored["previouslyMatchedEpisodes"])
        prefs = self._prefs()
        now = time.time()
        wanted = set(r["affectedFeeds"])
        out: list[dict] = []
        for feed in self._feeds.values():
            if feed.url not in wanted:
                continue
            for art in feed.articles:
                ok, _ = rule_matches(r, art["title"], smart_filters=prefs["smartFilters"],
                                     download_repacks=prefs["downloadRepacks"], now=now)
                if ok:
                    out.append({"feedId": feed.id, "articleId": art["id"], "title": art["title"],
                                "read": art["read"], "hasTorrent": bool(art["torrentUrl"])})
        return out

    def clear_episode_history(self, name: str) -> None:
        self._ensure_loaded()
        rule = self._rules.get(name)
        if rule is None:
            raise KeyError(name)
        if rule["previouslyMatchedEpisodes"]:
            rule["previouslyMatchedEpisodes"] = []
            self._save_rules_now()
            self._emit("rss.rules", {})
            self._reset_processing()  # a changed rule re-checks unread articles (qBittorrent)

    def _replace_rule_feed_url(self, old_url: str, new_url: str) -> None:
        changed = False
        for rule in self._rules.values():
            feeds = rule["affectedFeeds"]
            if old_url in feeds:
                rule["affectedFeeds"] = _merge_lists([new_url if u == old_url else u for u in feeds], [])
                changed = True
        if changed:
            self._save_rules_now()
            self._emit("rss.rules", {})

    # ------------------------------------------------------------ auto-download processing

    def _reset_processing(self) -> None:
        """qBittorrent's resetProcessingQueue(): queue every unread article again."""
        self._queue.clear()
        self._queued.clear()
        if self._closed or not self._started or not self._prefs()["autoDownload"]:
            return
        self._enqueue((f.id, a["id"]) for f in self._feeds.values() for a in f.articles
                      if not a["read"] and a["torrentUrl"])

    def _enqueue(self, jobs: Iterable[tuple[str, str]]) -> None:
        for job in jobs:
            if job not in self._queued:
                self._queued.add(job)
                self._queue.append(job)
        if self._queue and not self._closed and (self._worker is None or self._worker.done()):
            self._worker = self._spawn(self._process_queue(), name="promethea-rss-autodownload")

    async def _process_queue(self) -> None:
        while self._queue and not self._closed:
            job = self._queue.popleft()
            self._queued.discard(job)
            try:
                await self._process_job(*job)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("RSS auto-downloader: failed to process an article")

    async def _process_job(self, feed_id: str, article_id: str) -> None:
        prefs = self._prefs()
        if not prefs["autoDownload"]:
            return
        feed = self._feeds.get(feed_id)
        if feed is None:
            return
        art = feed.index.get(article_id)
        if art is None or art["read"] or not art["torrentUrl"]:
            return
        now = time.time()
        for rule in self._sorted_rules():
            if not rule["enabled"] or feed.url not in rule["affectedFeeds"]:
                continue
            ok, episodes = rule_matches(rule, art["title"], smart_filters=prefs["smartFilters"],
                                        download_repacks=prefs["downloadRepacks"], now=now)
            if not ok:
                continue
            # The first matching rule consumes the article.
            rule["lastMatch"] = int(now)
            if episodes:
                rule["previouslyMatchedEpisodes"] = _merge_lists(rule["previouslyMatchedEpisodes"], episodes)
            art["read"] = True
            self._save_rules_now()
            self._articles_changed(feed.id)
            self._emit("rss.rules", {})
            self._emit_feed(feed.id)
            log.info("RSS: article %r accepted by rule %r, adding torrent", art["title"], rule["name"])
            params = {
                "savePath": rule["savePath"] or None,
                # A folder of its own beats the category's (qBittorrent turns automatic management off).
                "autoTMM": False if rule["savePath"] else None,
                "category": rule["category"] or None,
                "tags": list(rule["tags"]),
                "paused": rule["addPaused"],
                "contentLayout": rule["contentLayout"],
                "source": "rss",
                "rule": rule["name"],
                "article": art["title"],
            }
            try:
                result = self._add_torrent(art["torrentUrl"], params)
                if inspect.isawaitable(result):
                    await result
            except asyncio.CancelledError:
                raise
            except Exception:
                # Not the URL: tracker links carry passkeys.
                log.exception("RSS: adding %r for rule %r failed", art["title"], rule["name"])
            return
