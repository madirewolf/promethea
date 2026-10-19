"""Result printer for nova3 search plugins (clean-room implementation for Promethea).

Plugins call ``prettyPrinter(result)`` once per search result, where ``result``
is a dict with the keys ``link, name, size, seeds, leech, engine_url`` and
optionally ``desc_link`` and ``pub_date``. Each result becomes one stdout line::

    link|name|size|seeds|leech|engine_url|desc_link|pub_date

``size`` is normalised to bytes and ``pub_date`` to a unix timestamp; ``-1``
means unknown, as in qBittorrent's output format.
"""

from __future__ import annotations

import datetime
import math
import re
import sys
import threading
from collections.abc import Mapping
from typing import Any

__all__ = ["prettyPrinter", "anySizeToBytes"]

_print_lock = threading.Lock()

# A number (allowing "," / "." separators) optionally followed by a unit.
_SIZE_RE = re.compile(r"(?P<num>\d[\d.,]*|\.\d+)\s*(?P<unit>[A-Za-z]+)?")
_THOUSANDS_COMMA_RE = re.compile(r"\d{1,3}(?:,\d{3})+")
_THOUSANDS_DOT_RE = re.compile(r"\d{1,3}(?:\.\d{3})+")
# Binary multiples, keyed by the first letter of the unit (KB, KiB, Ko, MB, ...).
_UNIT_EXPONENTS = {"K": 1, "M": 2, "G": 3, "T": 4, "P": 5, "E": 6, "Z": 7, "Y": 8}


def _parse_number(text: str) -> float | None:
    text = text.rstrip(".,")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):  # 1.234,5
            text = text.replace(".", "").replace(",", ".")
        else:  # 1,234.5
            text = text.replace(",", "")
    elif "," in text:
        if _THOUSANDS_COMMA_RE.fullmatch(text):  # 1,234
            text = text.replace(",", "")
        else:  # 1,5 (decimal comma)
            text = text.replace(",", ".")
    elif text.count(".") > 1:
        if not _THOUSANDS_DOT_RE.fullmatch(text):  # 1.234.567
            return None
        text = text.replace(".", "")
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def anySizeToBytes(size_string: Any) -> int:
    """Convert a size such as ``"1.5 GB"``, ``"700 MiB"`` or ``"123456"`` to bytes.

    Units use binary multiples (1 KB == 1024 bytes) like qBittorrent. Numbers are
    returned as-is. Returns -1 when the size is unknown or cannot be parsed.
    """
    if size_string is None or isinstance(size_string, bool):
        return -1
    if isinstance(size_string, int):
        return size_string if size_string >= 0 else -1
    if isinstance(size_string, float):
        return round(size_string) if math.isfinite(size_string) and size_string >= 0 else -1
    text = str(size_string).strip()
    if text.isdigit():
        return int(text)
    match = _SIZE_RE.match(text)
    if match is None:
        return -1
    number = _parse_number(match.group("num"))
    if number is None:
        return -1
    unit = (match.group("unit") or "").upper()
    exponent = _UNIT_EXPONENTS.get(unit[:1], 0)
    return round(number * (1024 ** exponent))


def _text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    for char in ("|", "\r", "\n", "\t"):
        text = text.replace(char, " ")
    return text.strip()


def _url(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text.replace("|", "%7C").replace("\r", "").replace("\n", "")


def _count(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return -1
    if isinstance(value, int):
        return value if value >= 0 else -1
    try:
        number = float(str(value).replace(",", "").strip())
    except ValueError:
        return -1
    return int(number) if math.isfinite(number) and number >= 0 else -1


def _timestamp(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return -1
    if isinstance(value, datetime.datetime):
        try:
            return int(value.timestamp())
        except (OverflowError, OSError, ValueError):
            return -1
    try:
        number = float(str(value).strip())
    except ValueError:
        return -1
    return int(number) if math.isfinite(number) and number > 0 else -1


def prettyPrinter(dictionary: Mapping[str, Any]) -> None:
    """Print one search result in the nova3 line format (thread-safe)."""
    get = dictionary.get
    line = "|".join((
        _url(get("link")),
        _text(get("name")),
        str(anySizeToBytes(get("size", -1))),
        str(_count(get("seeds"))),
        str(_count(get("leech"))),
        _url(get("engine_url")),
        _url(get("desc_link")),
        str(_timestamp(get("pub_date"))),
    ))
    # Strip lone surrogates so a strict UTF-8 stdout can never choke on a name.
    line = line.encode("utf-8", "replace").decode("utf-8")
    with _print_lock:
        out = sys.stdout
        if out is None:
            return
        out.write(line + "\n")
        out.flush()
