"""HTTP helpers for nova3 search plugins (clean-room implementation for Promethea).

Provides the API that qBittorrent search plugins import, e.g.::

    from helpers import retrieve_url, download_file, htmlentitydecode, headers
"""

from __future__ import annotations

import codecs
import datetime
import gzip
import html
import http.client
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections.abc import Mapping
from typing import Any

__all__ = [
    "download_file",
    "enable_socks_proxy",
    "headers",
    "htmlentitydecode",
    "retrieve_url",
    "user_agent",
]


def _browser_user_agent() -> str:
    """A current-looking Firefox UA: some sites block Python's default one."""
    # Firefox ships a new major version every four weeks; 125 came out on 2024-04-16.
    days = (datetime.date.today() - datetime.date(2024, 4, 16)).days
    version = 125 + max(days, 0) // 28
    return f"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:{version}.0) Gecko/20100101 Firefox/{version}.0"


user_agent: str = _browser_user_agent()
headers: dict[str, Any] = {"User-Agent": user_agent}

try:
    HTTP_TIMEOUT = float(os.environ.get("PROMETHEA_SEARCH_HTTP_TIMEOUT") or 40)
except ValueError:
    HTTP_TIMEOUT = 40.0

MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024


def htmlentitydecode(s: str) -> str:
    """Decode HTML entities (``&amp;``, ``&#233;``, ``&#xE9;`` ...)."""
    return html.unescape(s)


def enable_socks_proxy(enable: bool) -> None:
    """Compatibility no-op: Promethea does not route plugin traffic through SOCKS."""


def _gunzip(data: bytes) -> bytes:
    try:
        return gzip.decompress(data)
    except (OSError, EOFError, zlib.error):
        try:  # truncated stream: keep whatever decompresses
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(data)
        except zlib.error:
            return data


def _decompress(data: bytes, content_encoding: str | None) -> bytes:
    encoding = (content_encoding or "").strip().lower()
    if data[:2] == b"\x1f\x8b" or encoding in ("gzip", "x-gzip"):
        return _gunzip(data)
    if encoding == "deflate":
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):  # zlib-wrapped, then raw
            try:
                return zlib.decompress(data, wbits)
            except zlib.error:
                pass
    return data


def _request_body(request_data: Any) -> bytes | None:
    if request_data is None:
        return None
    if isinstance(request_data, (bytes, bytearray, memoryview)):
        return bytes(request_data)
    if isinstance(request_data, str):
        return request_data.encode("utf-8")
    if isinstance(request_data, (Mapping, list, tuple)):
        return urllib.parse.urlencode(request_data).encode("ascii")
    return request_data


def _open(request: urllib.request.Request, ssl_context: Any) -> http.client.HTTPResponse:
    return urllib.request.urlopen(request, timeout=HTTP_TIMEOUT, context=ssl_context)


def retrieve_url(
    url: str,
    custom_headers: Mapping[str, Any] = {},  # noqa: B006 - mirrors the nova3 signature
    request_data: Any = None,
    ssl_context: Any = None,
    unescape_html_entities: bool = True,
) -> str:
    """Return the content of ``url`` as text ("" on connection or HTTP errors).

    ``request_data`` turns the request into a POST. gzip/deflate bodies are
    decompressed, the text is decoded with the charset from Content-Type
    (default UTF-8) and HTML entities are unescaped unless told otherwise.
    """
    request_headers = {**headers, **dict(custom_headers or {})}
    if not any(str(k).lower() == "accept-encoding" for k in request_headers):
        request_headers["Accept-Encoding"] = "gzip, deflate"
    request = urllib.request.Request(url, data=_request_body(request_data), headers=request_headers)
    try:
        with _open(request, ssl_context) as response:
            data = response.read()
            content_encoding = response.headers.get("Content-Encoding")
            charset = response.headers.get_content_charset()
    except urllib.error.URLError as exc:
        print(f"Connection error: {getattr(exc, 'reason', exc)}", file=sys.stderr)
        return ""
    except (OSError, http.client.HTTPException) as exc:
        print(f"Connection error: {exc!r}", file=sys.stderr)
        return ""

    data = _decompress(data, content_encoding)
    try:
        codecs.lookup(charset or "utf-8")
    except LookupError:
        charset = None
    text = data.decode(charset or "utf-8", "replace")
    if text.startswith("﻿"):
        text = text[1:]
    if unescape_html_entities:
        text = html.unescape(text)
    return text


def download_file(url: str, referer: str | None = None, ssl_context: Any = None) -> str:
    """Download ``url`` into a temporary .torrent file and return ``"<path> <url>"``.

    A redirect to a magnet link returns ``"<magnet> <url>"`` instead.
    """
    request_headers = dict(headers)
    if referer is not None:
        request_headers["Referer"] = referer
    request = urllib.request.Request(url, headers=request_headers)
    try:
        with _open(request, ssl_context) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            content_encoding = response.headers.get("Content-Encoding")
    except urllib.error.HTTPError as exc:
        location = (exc.headers.get("Location") or "") if exc.headers else ""
        if 300 <= exc.code < 400 and location.lower().startswith("magnet:"):
            return f"{location} {url}"
        raise
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"{url} is larger than {MAX_DOWNLOAD_BYTES} bytes")
    data = _decompress(data, content_encoding)

    fd, path = tempfile.mkstemp(suffix=".torrent")
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return f"{path} {url}"
