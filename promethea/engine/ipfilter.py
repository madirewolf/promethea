"""IP filter loading (eMule .dat and PeerGuardian .p2p text formats)."""

from __future__ import annotations

import gzip
import ipaddress
import logging
from pathlib import Path

import libtorrent as lt

log = logging.getLogger("promethea.ipfilter")


def _norm(ip: str) -> str:
    # eMule lists zero-pad octets ("001.002.003.004"), which ipaddress rejects.
    ip = ip.strip()
    if "." in ip and ":" not in ip:
        ip = ".".join(str(int(part)) for part in ip.split("."))
    return str(ipaddress.ip_address(ip))


def parse_filter_file(path: str) -> list[tuple[str, str]]:
    """Return blocked (first, last) ranges. Raises OSError/ValueError on unreadable files."""
    p = Path(path)
    raw = p.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8", "replace")
    ranges: list[tuple[str, str]] = []
    bad = 0
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#;/":
            continue
        try:
            if "," in line and " - " in line.split(",", 1)[0]:
                # eMule: "first - last , access , description"
                parts = [x.strip() for x in line.split(",")]
                first, last = (x.strip() for x in parts[0].split("-", 1))
                if len(parts) > 1 and parts[1].isdigit() and int(parts[1]) > 127:
                    continue  # access level > 127 means allowed
                ranges.append((_norm(first), _norm(last)))
            elif ":" in line and "-" in line.rsplit(":", 1)[-1]:
                # PeerGuardian: "description:first-last"
                desc, rng = line.rsplit(":", 1)
                first, last = rng.split("-", 1)
                ranges.append((_norm(first), _norm(last)))
            elif "-" in line:
                first, last = line.split("-", 1)
                ranges.append((_norm(first), _norm(last)))
            else:
                ip = _norm(line)
                ranges.append((ip, ip))
        except ValueError:
            bad += 1
    if bad:
        log.info("ip filter %s: skipped %d unparsable lines", path, bad)
    return ranges


def build_filter(ranges: list[tuple[str, str]], banned: list[str]) -> tuple[object, int]:
    f = lt.ip_filter()
    count = 0
    for first, last in ranges:
        try:
            a, b = ipaddress.ip_address(first), ipaddress.ip_address(last)
            if a.version != b.version:
                continue
            f.add_rule(first, last, 1)
            count += 1
        except (ValueError, RuntimeError):
            continue
    for ip in banned:
        try:
            norm = _norm(ip)
            f.add_rule(norm, norm, 1)
            count += 1
        except (ValueError, RuntimeError):
            continue
    return f, count
