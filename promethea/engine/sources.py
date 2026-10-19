"""Turning .torrent files, magnet links and URLs into libtorrent add params."""

from __future__ import annotations

import fnmatch
import os
import posixpath
from dataclasses import dataclass, field
from typing import Any

import libtorrent as lt

from .model import torrent_id

MAX_TORRENT_SIZE = 50 * 1024 * 1024


class SourceError(ValueError):
    pass


@dataclass
class AddOptions:
    savePath: str | None = None
    downloadPath: str | None = None
    useDownloadPath: bool | None = None
    category: str | None = None
    tags: list[str] = field(default_factory=list)
    paused: bool | None = None
    stopCondition: str | None = None
    sequential: bool = False
    firstLast: bool = False
    skipChecking: bool = False
    contentLayout: str | None = None
    addToTop: bool | None = None
    autoTMM: bool | None = None
    filePriorities: list[int] | dict[int, int] | None = None  # full list, or {file index: priority}
    renames: dict[int, str] | None = None
    name: str | None = None
    dlLimit: int = 0
    upLimit: int = 0
    ratioLimit: float = -2.0
    seedingTimeLimit: int = -2
    inactiveSeedingTimeLimit: int = -2
    source: str = "user"

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "AddOptions":
        opts = cls()
        if not d:
            return opts
        for key, value in d.items():
            if not hasattr(opts, key) or value is None and key in ("tags",):
                continue
            if key == "renames" and isinstance(value, dict):
                value = {int(k): str(v) for k, v in value.items()}
            if key == "filePriorities" and isinstance(value, dict):
                value = {int(k): int(v) for k, v in value.items()}
            if key == "tags" and isinstance(value, str):
                value = [t.strip() for t in value.split(",") if t.strip()]
            setattr(opts, key, value)
        return opts


def load_torrent_bytes(data: bytes) -> Any:
    """Parse .torrent bytes into add_torrent_params (raises SourceError)."""
    if len(data) > MAX_TORRENT_SIZE:
        raise SourceError("torrent file is too large")
    try:
        atp = lt.load_torrent_buffer(data)
    except RuntimeError as e:
        raise SourceError(f"not a valid torrent file ({e})") from None
    if atp.ti is None or not atp.ti.is_valid():
        raise SourceError("not a valid torrent file")
    return atp


def load_magnet(uri: str) -> Any:
    try:
        atp = lt.parse_magnet_uri(uri.strip())
    except RuntimeError as e:
        raise SourceError(f"invalid magnet link ({e})") from None
    ih = atp.info_hashes
    if not ih.has_v1() and not ih.has_v2():
        raise SourceError("magnet link has no info hash")
    return atp


def is_magnet(text: str) -> bool:
    return text.strip().lower().startswith("magnet:?")


def is_info_hash(text: str) -> bool:
    t = text.strip()
    if len(t) == 40:
        return all(c in "0123456789abcdefABCDEF" for c in t)
    if len(t) == 32:  # base32 v1 hash
        return all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for c in t.upper())
    return False


def files_of(ti: Any) -> list[dict[str, Any]]:
    """File list (pad files excluded) with '/' separated paths."""
    fs = ti.layout()
    out = []
    pad = int(fs.flag_pad_file)
    for i in range(fs.num_files()):
        if fs.file_flags(i) & pad:
            continue
        out.append({"index": i, "path": fs.file_path(i).replace("\\", "/"), "size": fs.file_size(i)})
    return out


def has_root_folder(paths: list[str]) -> bool:
    if not paths:
        return False
    roots = set()
    for p in paths:
        if "/" not in p:
            return False
        roots.add(p.split("/", 1)[0])
    return len(roots) == 1


def layout_renames(ti: Any, layout: str) -> dict[int, str]:
    """File renames that implement a content layout (qBittorrent semantics)."""
    if layout not in ("subfolder", "noSubfolder"):
        return {}
    files = files_of(ti)
    paths = [f["path"] for f in files]
    root = has_root_folder(paths)
    renames: dict[int, str] = {}
    if layout == "noSubfolder" and root:
        for f in files:
            renames[f["index"]] = f["path"].split("/", 1)[1]
    elif layout == "subfolder" and not root:
        folder = os.path.splitext(ti.name())[0] if len(files) == 1 else ti.name()
        for f in files:
            renames[f["index"]] = posixpath.join(folder, f["path"])
    return renames


def excluded_priorities(ti: Any, patterns_text: str) -> dict[int, int]:
    """Priority 0 for files whose name matches an excluded pattern."""
    patterns = [p.strip() for p in patterns_text.splitlines() if p.strip()]
    if not patterns:
        return {}
    out = {}
    for f in files_of(ti):
        name = f["path"].rsplit("/", 1)[-1].lower()
        full = f["path"].lower()
        for pat in patterns:
            pat_l = pat.lower()
            if fnmatch.fnmatchcase(name, pat_l) or fnmatch.fnmatchcase(full, pat_l):
                out[f["index"]] = 0
                break
    return out


def file_fields(atp: Any) -> tuple[str, str, int]:
    """Comment, creator and creation date of a loaded .torrent (kept outside torrent_info in libtorrent 2.1)."""
    if atp is None:
        return "", "", 0
    return (str(getattr(atp, "comment", "") or ""), str(getattr(atp, "created_by", "") or ""),
            int(getattr(atp, "creation_date", 0) or 0))


def describe_ti(ti: Any, atp: Any = None) -> dict[str, Any]:
    """Torrent info for the add dialog; pass the add params a .torrent was loaded into, when there are some."""
    files = files_of(ti)
    ih = ti.info_hashes()
    comment, creator, created = file_fields(atp)
    info = {
        "id": torrent_id(ih),
        "name": ti.name(),
        "totalSize": sum(f["size"] for f in files),
        "files": files,
        "hasRootFolder": has_root_folder([f["path"] for f in files]),
        "comment": comment,
        "createdBy": creator,
        "creationDate": created or int(ti.creation_date() or 0),
        "private": bool(ti.priv()),
        "pieceSize": ti.piece_length(),
        "numPieces": ti.num_pieces(),
        "infohashV1": str(ih.v1) if ih.has_v1() else "",
        "infohashV2": str(ih.v2) if ih.has_v2() else "",
        "hasMetadata": True,
    }
    if atp is not None:
        # Without add params (a magnet's metadata arriving) the magnet's own trackers stand.
        info["trackers"] = list(atp.trackers)
        info["webSeeds"] = list(atp.url_seeds)
    return info


def describe_magnet(atp: Any) -> dict[str, Any]:
    ih = atp.info_hashes
    return {
        "id": torrent_id(ih),
        "name": atp.name or "",
        "totalSize": -1,
        "files": [],
        "hasRootFolder": False,
        "comment": "",
        "createdBy": "",
        "creationDate": 0,
        "private": False,
        "pieceSize": 0,
        "numPieces": 0,
        "trackers": list(atp.trackers),
        "webSeeds": list(atp.url_seeds),
        "infohashV1": str(ih.v1) if ih.has_v1() else "",
        "infohashV2": str(ih.v2) if ih.has_v2() else "",
        "hasMetadata": False,
    }


def torrent_file_bytes(handle: Any) -> bytes:
    """Rebuild a .torrent file for a torrent that has metadata."""
    ti = handle.torrent_file()
    if ti is None:
        raise SourceError("torrent has no metadata yet")
    atp = lt.add_torrent_params()
    atp.ti = ti
    tiers: dict[int, list[str]] = {}
    for t in handle.trackers():
        tiers.setdefault(int(t.get("tier", 0)), []).append(t["url"])
    atp.trackers = [url for tier in sorted(tiers) for url in tiers[tier]]
    atp.tracker_tiers = [tier for tier in sorted(tiers) for _ in tiers[tier]]
    atp.url_seeds = list(handle.url_seeds())
    # write_torrent_file_buf() tries to decode its binary result as UTF-8 in the
    # Python bindings, so build the entry and bencode it ourselves.
    return lt.bencode(lt.write_torrent_file(atp, lt.write_flags.allow_missing_piece_layer))
