"""Per-torrent bookkeeping and conversion of libtorrent status to UI dicts."""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field, fields
from typing import Any

import libtorrent as lt

TF = lt.torrent_flags
S = lt.torrent_status.states

PAUSED = int(TF.paused)
AUTO_MANAGED = int(TF.auto_managed)
SEQUENTIAL = int(TF.sequential_download)
SUPER_SEEDING = int(TF.super_seeding)
UPLOAD_MODE = int(TF.upload_mode)

MAX_RATIO = 9999.0

# torrent_handle::status() query flags. The Python bindings only export some of
# them, but the calls accept plain ints.
Q_DISTRIBUTED_COPIES = 1
Q_ACCURATE_COUNTERS = 2
Q_LAST_SEEN_COMPLETE = 4
Q_PIECES = 8
Q_VERIFIED_PIECES = 16
Q_TORRENT_FILE = 32
Q_NAME = 64
Q_SAVE_PATH = 128
# What the transfer list needs on every refresh (cheap; no piece bitfields).
STATUS_FLAGS = Q_DISTRIBUTED_COPIES | Q_LAST_SEEN_COMPLETE | Q_NAME | Q_SAVE_PATH

# Torrent states (same vocabulary as qBittorrent so behaviour is familiar).
DOWNLOADING_STATES = {
    "downloading", "metaDL", "forcedMetaDL", "forcedDL", "stalledDL", "queuedDL", "stoppedDL", "checkingDL",
}
SEEDING_STATES = {"uploading", "forcedUP", "stalledUP", "queuedUP", "checkingUP"}

_MISSING_FILE_ERRORS = {2, 3}  # ENOENT / ERROR_PATH_NOT_FOUND


@dataclass
class TorrentMeta:
    """Promethea-side data that libtorrent does not keep for us."""

    category: str = ""
    tags: list[str] = field(default_factory=list)
    name: str = ""  # custom display name ("" = torrent's own name)
    savePath: str = ""  # final location
    downloadPath: str = ""  # location while incomplete ("" = not used)
    autoTMM: bool = False
    ratioLimit: float = -2.0  # -2 = use global, -1 = no limit
    seedingTimeLimit: int = -2  # minutes; -2 = global, -1 = none
    inactiveSeedingTimeLimit: int = -2
    firstLastPiece: bool = False
    stopCondition: str = "none"  # none | metadata | checked
    pendingLayout: str = ""  # content layout to apply once metadata arrives
    pendingPriorities: list[int] = field(default_factory=list)
    addedOn: int = 0
    source: str = ""
    queuePos: int = -1
    seedLimitHandled: bool = False
    notifiedComplete: bool = False
    appendExtension: bool = False
    # From the .torrent file: libtorrent 2.1 keeps these on the add params, not in torrent_info.
    comment: str = ""
    createdBy: str = ""
    creationDate: int = 0

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "TorrentMeta":
        meta = cls()
        if not isinstance(d, dict):
            return meta
        names = {f.name for f in fields(cls)}
        for k, v in d.items():
            if k in names:
                setattr(meta, k, v)
        return meta

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def torrent_id(obj: Any) -> str:
    """Stable id: v1 info hash, or the truncated v2 hash for v2-only torrents.

    Accepts an info_hash_t, or anything exposing `info_hashes` as a method
    (handles, torrent_info) or attribute (status, add_torrent_params, alerts).
    """
    ih = getattr(obj, "info_hashes", obj)
    if callable(ih):
        ih = ih()
    if ih.has_v1():
        return str(ih.v1)
    return str(ih.v2)[:40]


class Entry:
    """A torrent known to the engine."""

    __slots__ = (
        "id", "handle", "meta", "status", "snapshot", "dl_avg", "error", "missing_files",
        "has_metadata", "name", "total_size", "num_files", "is_private", "removing", "moving",
        "last_active", "files_cache", "prev_finished", "hidden", "tracker_hosts", "prio_wanted", "prio_jobs",
    )

    def __init__(self, tid: str, handle: Any, meta: TorrentMeta) -> None:
        self.id = tid
        self.handle = handle
        self.meta = meta
        self.status: Any = None
        self.snapshot: dict[str, Any] = {}
        self.dl_avg = 0.0
        self.error = ""
        self.missing_files = False
        self.has_metadata = False
        self.name = ""
        self.total_size = 0
        self.num_files = 0
        self.is_private = False
        self.removing = False
        self.moving = False
        self.last_active = 0
        self.files_cache: Any = None
        self.prev_finished = False
        self.hidden = False
        self.tracker_hosts: list[str] = []
        #: File priorities sent to libtorrent that its disk thread may not have applied yet,
        #: and how many of those changes are still in flight.
        self.prio_wanted: list[int] | None = None
        self.prio_jobs = 0

    # -- derived values -------------------------------------------------
    def file_priorities(self) -> list[int]:
        """File priorities, counting changes libtorrent is still applying.

        libtorrent reports a change only after its disk thread has applied it, so reading
        right after a change returns the old values (and writing those back undoes it).
        """
        if self.prio_wanted is not None:
            return list(self.prio_wanted)
        return list(self.handle.get_file_priorities())

    def display_name(self) -> str:
        if self.meta.name:
            return self.meta.name
        st = self.status
        if st is not None and st.name:
            return st.name
        return self.name or self.id

    def is_paused(self) -> bool:
        return bool(self.status is not None and int(self.status.flags) & PAUSED)

    def is_auto_managed(self) -> bool:
        return bool(self.status is not None and int(self.status.flags) & AUTO_MANAGED)

    def is_stopped(self) -> bool:
        return self.is_paused() and not self.is_auto_managed()

    def is_finished(self) -> bool:
        st = self.status
        return st is not None and st.state in (S.finished, S.seeding)


def ratio_of(st: Any) -> float:
    upload = st.all_time_upload
    download = st.all_time_download
    if download < st.total_done * 0.01:
        download = st.total_done
    if download <= 0:
        return 0.0 if upload == 0 else MAX_RATIO
    return min(upload / download, MAX_RATIO)


def payload_rates(st: Any) -> tuple[int, int]:
    """Download and upload payload rates. libtorrent stops updating a paused torrent's rates
    rather than zeroing them, so a stopped or errored torrent would keep its last speed."""
    if int(st.flags) & PAUSED:
        return 0, 0
    return st.download_payload_rate, st.upload_payload_rate


def compute_state(e: Entry) -> str:
    st = e.status
    if st is None:
        return "unknown"
    flags = int(st.flags)
    paused = bool(flags & PAUSED)
    auto = bool(flags & AUTO_MANAGED)
    if st.state == S.checking_resume_data:
        return "checkingResumeData"
    if e.moving or st.moving_storage:
        return "moving"
    if e.missing_files:
        return "missingFiles"
    if e.error:
        return "error"
    finished = st.state in (S.finished, S.seeding)
    if not st.has_metadata:
        if paused and not auto:
            return "stoppedDL"
        if paused and auto:
            return "queuedDL"
        return "metaDL" if auto else "forcedMetaDL"
    if st.state in (S.checking_files, S.queued_for_checking) and (not paused or auto):
        return "checkingUP" if e.prev_finished or st.progress >= 1.0 else "checkingDL"
    if st.state == S.allocating:
        return "allocating"
    if finished:
        if paused and not auto:
            return "stoppedUP"
        if paused:
            return "queuedUP"
        if not auto:
            return "forcedUP"
        return "uploading" if payload_rates(st)[1] > 0 else "stalledUP"
    if paused and not auto:
        return "stoppedDL"
    if paused:
        return "queuedDL"
    if not auto:
        return "forcedDL"
    return "downloading" if st.download_payload_rate > 0 else "stalledDL"


def error_message(st: Any) -> tuple[str, bool]:
    """(message, is_missing_files) for a status with an error."""
    try:
        ec = st.errc
        if ec.value() == 0:
            return "", False
        msg = ec.message()
        missing = ec.value() in _MISSING_FILE_ERRORS and ec.category().name() in ("system", "generic")
        return msg, missing
    except Exception:  # noqa: BLE001
        return (st.error or ""), False


def serialize(e: Entry, now: float, global_ratio_limit: float, global_seed_limit: int,
              global_inactive_limit: int) -> dict[str, Any]:
    st = e.status
    meta = e.meta
    flags = int(st.flags)
    state = compute_state(e)
    total_wanted = st.total_wanted
    done = st.total_wanted_done
    remaining = max(0, total_wanted - done)

    dl_rate, ul_rate = payload_rates(st)
    # Smooth the rate for a calm ETA.
    e.dl_avg = dl_rate if e.dl_avg == 0 else e.dl_avg * 0.8 + dl_rate * 0.2
    eta = -1
    if state in ("downloading", "forcedDL", "stalledDL", "metaDL", "forcedMetaDL") and remaining > 0:
        rate = max(e.dl_avg, dl_rate)
        if rate > 1:
            eta = int(remaining / rate)

    added = int(st.added_time or meta.addedOn or 0)
    completed = int(st.completed_time or 0)
    last_activity = 0
    if st.time_since_download is not None or st.time_since_upload is not None:
        tsd = _secs(st.time_since_download)
        tsu = _secs(st.time_since_upload)
        candidates = [x for x in (tsd, tsu) if x is not None and x >= 0]
        if candidates:
            last_activity = int(now - min(candidates))
    if dl_rate > 0 or ul_rate > 0:
        last_activity = int(now)

    queue = st.queue_position
    return {
        "id": e.id,
        "name": e.display_name(),
        "state": state,
        "progress": round(st.progress, 6) if st.has_metadata else 0.0,
        "size": total_wanted,
        "totalSize": e.total_size or st.total,
        "completed": done,
        "remaining": remaining,
        "dlSpeed": dl_rate,
        "upSpeed": ul_rate,
        "eta": eta,
        "seeds": st.num_seeds,
        "seedsTotal": max(st.num_complete, st.list_seeds) if st.num_complete >= 0 else st.list_seeds,
        "peers": max(0, st.num_peers - st.num_seeds),
        "peersTotal": max(st.num_incomplete, st.list_peers - st.list_seeds) if st.num_incomplete >= 0
        else max(0, st.list_peers - st.list_seeds),
        "ratio": round(ratio_of(st), 3),
        "downloaded": st.all_time_download,
        "uploaded": st.all_time_upload,
        "dlSession": st.total_payload_download,
        "upSession": st.total_payload_upload,
        "category": meta.category,
        "tags": list(meta.tags),
        "savePath": meta.savePath or st.save_path,
        "currentPath": st.save_path,
        "downloadPath": meta.downloadPath,
        "addedOn": added,
        "completedOn": completed,
        "lastActivity": last_activity,
        "timeActive": int(_secs(st.active_duration) or 0),
        "seedingTime": int(_secs(st.seeding_duration) or 0),
        "seenComplete": int(st.last_seen_complete or 0),
        "availability": round(st.distributed_copies, 3) if st.distributed_copies >= 0 else -1,
        "queue": queue if queue >= 0 and not st.is_seeding else -1,
        "dlLimit": max(0, st.download_limit if hasattr(st, "download_limit") else 0),
        "upLimit": max(0, st.upload_limit if hasattr(st, "upload_limit") else 0),
        "seqDl": bool(flags & SEQUENTIAL),
        "firstLast": meta.firstLastPiece,
        "superSeeding": bool(flags & SUPER_SEEDING),
        "forceStart": not (flags & AUTO_MANAGED) and not (flags & PAUSED),
        "autoTMM": meta.autoTMM,
        "tracker": st.current_tracker,
        "trackerHosts": e.tracker_hosts,
        "connections": st.num_connections,
        "hasMetadata": bool(st.has_metadata),
        "private": e.is_private,
        "error": e.error,
        "ratioLimit": meta.ratioLimit,
        "seedingTimeLimit": meta.seedingTimeLimit,
        "inactiveSeedingTimeLimit": meta.inactiveSeedingTimeLimit,
        "effectiveRatioLimit": _effective(meta.ratioLimit, global_ratio_limit),
        "numFiles": e.num_files,
    }


def _effective(value: float, global_value: float) -> float:
    return global_value if value == -2 else value


def _secs(v: Any) -> float | None:
    """libtorrent durations may come back as timedelta, seconds or None."""
    if v is None:
        return None
    if hasattr(v, "total_seconds"):
        return v.total_seconds()
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def diff(prev: dict[str, Any] | None, cur: dict[str, Any]) -> dict[str, Any]:
    if prev is None:
        return dict(cur)
    return {k: v for k, v in cur.items() if prev.get(k) != v}


def now_ts() -> int:
    return int(time.time())
