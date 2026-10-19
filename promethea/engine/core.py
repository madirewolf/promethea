"""The torrent engine: owns the libtorrent session and all torrent state.

Everything here runs on one asyncio event loop. libtorrent does its own
networking and disk I/O on native threads; we only block a dedicated worker
thread in `wait_for_alert`, so the UI stays responsive at any transfer speed.
"""

from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import datetime as dt
import logging
import os
import posixpath
import shutil
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable

import aiohttp
import libtorrent as lt

from .. import __version__
from ..platform import (
    IS_WINDOWS,
    SleepInhibitor,
    delete_paths,
    free_space,
    recycle,
    remove_empty_dirs,
    run_external,
)
from ..prefs import Prefs, lt_settings
from ..util import atomic_write_bytes, atomic_write_json, error_text, read_json
from . import details
from ..creator import CreateJob, start_job
from ..creator import inspect as creator_inspect
from .ipfilter import build_filter, parse_filter_file
from .model import (
    AUTO_MANAGED,
    PAUSED,
    SEQUENTIAL,
    STATUS_FLAGS,
    SUPER_SEEDING,
    Entry,
    TorrentMeta,
    diff,
    error_message,
    ratio_of,
    serialize,
    torrent_id,
)
from .sources import (
    AddOptions,
    SourceError,
    describe_magnet,
    describe_ti,
    excluded_priorities,
    file_fields,
    files_of,
    is_info_hash,
    is_magnet,
    layout_renames,
    load_magnet,
    load_torrent_bytes,
    torrent_file_bytes,
)

log = logging.getLogger("promethea.engine")

TF = lt.torrent_flags
INCOMPLETE_EXT = details.INCOMPLETE_EXT


class DuplicateTorrent(SourceError):
    def __init__(self, tid: str, name: str, trackers: int = 0, web_seeds: int = 0) -> None:
        msg = f"'{name}' is already in your transfer list"
        merged = [f"{n} {what}{'' if n == 1 else 's'}" for n, what in ((trackers, "tracker"), (web_seeds, "web seed")) if n]
        if merged:
            msg += f"; added {' and '.join(merged)} to it"
        super().__init__(msg)
        self.tid = tid
        self.trackers = trackers
        self.web_seeds = web_seeds


class NotFound(KeyError):
    pass


class Probe:
    """A magnet whose metadata is being fetched for the add dialog."""

    def __init__(self, token: str, tid: str, handle: Any, magnet: str) -> None:
        self.token = token
        self.tid = tid
        self.handle = handle
        self.magnet = magnet
        self.ti: Any = None
        self.created = time.monotonic()


class Pending:
    """A source inspected by the add dialog, waiting for confirmation."""

    def __init__(self, kind: str, *, data: bytes = b"", magnet: str = "", path: str = "") -> None:
        self.kind = kind  # "bytes" | "magnet"
        self.data = data
        self.magnet = magnet
        self.path = path
        self.created = time.monotonic()


class Engine:
    def __init__(self, data_dir: Path, prefs: Prefs, emit: Callable[[str, dict], None]) -> None:
        self.data_dir = data_dir
        self.torrents_dir = data_dir / "torrents"
        self.torrents_dir.mkdir(parents=True, exist_ok=True)
        self.probe_dir = data_dir / "probe"
        self.prefs = prefs
        self.emit = emit
        self.ses: Any = None
        self.entries: dict[str, Entry] = {}
        self.probes: dict[str, Probe] = {}
        self.pending: dict[str, Pending] = {}
        self.categories: dict[str, dict[str, Any]] = {}
        self.tags: list[str] = []
        self.alt_speed = prefs["speed"]["altEnabled"]
        self.started = time.time()
        self.log: collections.deque[dict[str, Any]] = collections.deque(maxlen=3000)
        self.blocked: collections.deque[dict[str, Any]] = collections.deque(maxlen=1000)
        #: The entry each (ip, reason) got this minute: repeats count there instead of piling up.
        self._blocked_recent: dict[tuple[str, str], dict[str, Any]] = {}
        self._log_id = 0
        self._metas: dict[str, dict[str, Any]] = {}
        self._dirty: set[str] = set()
        self._files_changed: set[str] = set()
        #: The last file error and torrent error reported per torrent: a failure that hits
        #: several disk jobs at once is reported once (until the error is cleared).
        self._file_errors: dict[str, str] = {}
        self._torrent_errors: dict[str, str] = {}
        self._removed: list[str] = []
        self._cats_dirty = True
        self._tags_dirty = True
        self._meta_dirty = False
        self._sync_listeners: list[Callable[[dict], None]] = []
        self._closing = False
        self._task: asyncio.Task | None = None
        self._alert_pool = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="lt-alerts")
        self._http: aiohttp.ClientSession | None = None
        self._removal_events: dict[str, asyncio.Event] = {}
        self._stats_prev: dict[str, Any] | None = None
        self._stats_time = 0.0
        self.server: dict[str, Any] = {}
        self._server_sent: dict[str, Any] = {}
        hist_len = max(60, prefs["advanced"]["speedHistoryMinutes"] * 60)
        self.history: collections.deque[tuple[int, int, int]] = collections.deque(maxlen=hist_len)
        self._last_hist: tuple[int, int, int] | None = None
        self._totals = read_json(data_dir / "stats.json", {}) or {}
        self._totals.setdefault("dl", 0)
        self._totals.setdefault("ul", 0)
        self._session_base = (0, 0)
        self._free_space = -1
        self._sleep = SleepInhibitor()
        self._schedule_state: bool | None = None
        self._watch_seen: dict[str, tuple[int, float]] = {}
        self.jobs: dict[str, CreateJob] = {}
        self._inspect_gen = 0
        self.listen_port = 0
        self.external_ip = ""
        self._ticks = 0
        self._last_resume_sweep = time.monotonic()
        self._last_stats_save = time.monotonic()
        self._perf_seen: dict[str, float] = {}

    # ------------------------------------------------------------------ setup
    def _fingerprint(self) -> str:
        major, minor, *_ = (__version__.split(".") + ["0", "0"])[:3]
        return lt.generate_fingerprint("SG", int(major), int(minor), 0, 0)

    def settings(self) -> dict[str, Any]:
        return lt_settings(self.prefs, alt_speed=self.alt_speed, fingerprint=self._fingerprint())

    async def open(self) -> None:
        self.categories = read_json(self.data_dir / "categories.json", {}) or {}
        self.tags = sorted(set(read_json(self.data_dir / "tags.json", []) or []), key=str.lower)
        self._metas = read_json(self.data_dir / "torrents.json", {}) or {}
        shutil.rmtree(self.probe_dir, ignore_errors=True)

        params = lt.session_params()
        state_file = self.data_dir / "session.state"
        if state_file.exists():
            try:
                params = lt.read_session_params(state_file.read_bytes(), lt.save_state_flags_t.save_dht_state)
            except Exception:  # noqa: BLE001
                log.warning("could not read saved DHT state; starting fresh")
        params.settings = self.settings()
        self.ses = lt.session(params)
        self._apply_ip_filter()
        self._log("info", f"Promethea {__version__} started (libtorrent {lt.__version__})")

        # Restore torrents in their saved queue order.
        resume_files = list(self.torrents_dir.glob("*.fastresume"))
        known = {p.stem for p in resume_files}
        self._metas = {k: v for k, v in self._metas.items() if k in known}
        resume_files.sort(key=lambda p: (self._metas.get(p.stem, {}).get("queuePos", -1) < 0,
                                         self._metas.get(p.stem, {}).get("queuePos", 0)))
        restored = 0
        for path in resume_files:
            try:
                atp = lt.read_resume_data(path.read_bytes())
            except Exception as e:  # noqa: BLE001
                self._log("warning", f"Could not load resume data {path.name}: {error_text(e)}")
                continue
            meta = self._metas.get(path.stem)
            if isinstance(meta, dict) and "comment" not in meta:
                # Torrents added before Promethea kept these itself: the resume data has them.
                meta.update(zip(("comment", "createdBy", "creationDate"), file_fields(atp)))
            atp.flags = int(atp.flags) & ~int(TF.duplicate_is_error)
            self.ses.async_add_torrent(atp)
            restored += 1
        if restored:
            self._log("info", f"Restoring {restored} torrent(s)")
        self._task = asyncio.create_task(self._run(), name="engine-loop")

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        loop = asyncio.get_running_loop()
        self.ses.pause()
        outstanding = 0
        for e in list(self.entries.values()):
            try:
                if e.handle.is_valid():
                    e.handle.save_resume_data(lt.save_resume_flags_t.flush_disk_cache | lt.save_resume_flags_t.save_info_dict)
                    outstanding += 1
            except RuntimeError:
                pass
        deadline = time.monotonic() + 20
        while outstanding > 0 and time.monotonic() < deadline:
            await loop.run_in_executor(self._alert_pool, self.ses.wait_for_alert, 500)
            for a in self.ses.pop_alerts():
                name = type(a).__name__
                if name == "save_resume_data_alert":
                    self._on_save_resume_data_alert(a)
                    outstanding -= 1
                elif name == "save_resume_data_failed_alert":
                    outstanding -= 1
        self._save_meta(force=True)
        self._save_stats()
        try:
            state = self.ses.session_state(lt.save_state_flags_t.save_dht_state)
            atomic_write_bytes(self.data_dir / "session.state",
                               lt.write_session_params_buf(state, lt.save_state_flags_t.save_dht_state))
        except Exception as e:  # noqa: BLE001
            log.warning("could not save DHT state: %s", e)
        for probe in list(self.probes.values()):
            try:
                self.ses.remove_torrent(probe.handle)
            except RuntimeError:
                pass
        if self._http:
            await self._http.close()
        self._sleep.set(False)
        # Destroying the session sends tracker "stopped" events (bounded by
        # stop_tracker_timeout), so drop the last reference on the worker thread.
        holder = [self.ses]
        self.ses = None
        await loop.run_in_executor(self._alert_pool, _destroy, holder)
        self._alert_pool.shutdown(wait=False)

    # ------------------------------------------------------------- main loop
    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        next_tick = time.monotonic()
        while not self._closing:
            try:
                await loop.run_in_executor(self._alert_pool, self.ses.wait_for_alert, 100)
                for a in self.ses.pop_alerts():
                    handler = getattr(self, "_on_" + type(a).__name__, None)
                    if handler is not None:
                        try:
                            handler(a)
                        except Exception:  # noqa: BLE001
                            log.exception("error handling %s", type(a).__name__)
                # One event per torrent and batch: renaming a folder renames every file in it.
                for tid in self._files_changed:
                    self.emit("torrent.files", {"id": tid})
                self._files_changed.clear()
                now = time.monotonic()
                if now >= next_tick:
                    interval = max(0.25, self.prefs["advanced"]["uiRefreshInterval"] / 1000)
                    next_tick = now + interval
                    self._tick(now)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("engine loop error")
                await asyncio.sleep(0.5)

    def _tick(self, now: float) -> None:
        self._ticks += 1
        self.ses.post_torrent_updates(STATUS_FLAGS)
        self.ses.post_session_stats()
        if self._ticks % 5 == 0:
            self._check_seeding_limits()
            self._check_schedule()
            self._update_sleep()
            asyncio.get_running_loop().create_task(self._scan_watched())
            self._expire_pending()
        if self._ticks % 10 == 1:
            asyncio.get_running_loop().create_task(self._refresh_free_space())
        sweep = self.prefs["advanced"]["resumeSaveInterval"] * 60
        if sweep > 0 and now - self._last_resume_sweep > sweep:
            self._last_resume_sweep = now
            for e in self.entries.values():
                try:
                    if e.handle.need_save_resume_data():
                        e.handle.save_resume_data(lt.save_resume_flags_t.save_info_dict)
                except RuntimeError:
                    pass
        if now - self._last_stats_save > 60:
            self._last_stats_save = now
            self._save_stats()
        if self._meta_dirty:
            self._save_meta()

    # ------------------------------------------------------------ sync model
    def add_sync_listener(self, cb: Callable[[dict], None]) -> None:
        self._sync_listeners.append(cb)

    def remove_sync_listener(self, cb: Callable[[dict], None]) -> None:
        if cb in self._sync_listeners:
            self._sync_listeners.remove(cb)

    def _globals(self) -> tuple[float, int, int]:
        b = self.prefs["bittorrent"]
        ratio = b["ratioLimit"] if b["ratioLimitEnabled"] else -1
        seed = b["seedingTimeLimit"] if b["seedingTimeLimitEnabled"] else -1
        inactive = b["inactiveSeedingTimeLimit"] if b["inactiveSeedingTimeLimitEnabled"] else -1
        return ratio, seed, inactive

    def _serialize(self, e: Entry) -> dict[str, Any]:
        return serialize(e, time.time(), *self._globals())

    def full_sync(self) -> dict[str, Any]:
        torrents = {}
        for tid, e in self.entries.items():
            if e.status is None:
                continue
            torrents[tid] = e.snapshot or self._serialize(e)
        return {
            "t": "full",
            "torrents": torrents,
            "server": dict(self.server),
            "categories": self.categories_public(),
            "tags": list(self.tags),
            "history": list(self.history),
        }

    def _build_delta(self) -> dict[str, Any] | None:
        torrents: dict[str, Any] = {}
        for tid in self._dirty:
            e = self.entries.get(tid)
            if e is None or e.status is None:
                continue
            snap = self._serialize(e)
            d = diff(e.snapshot or None, snap)
            if d:
                torrents[tid] = d
                e.snapshot = snap
        self._dirty.clear()
        delta: dict[str, Any] = {"t": "delta"}
        if torrents:
            delta["torrents"] = torrents
        if self._removed:
            delta["removed"] = self._removed
            self._removed = []
        server = diff(self._server_sent or None, self.server)
        if server:
            delta["server"] = server
            self._server_sent = dict(self.server)
        if self._cats_dirty:
            delta["categories"] = self.categories_public()
            self._cats_dirty = False
        if self._tags_dirty:
            delta["tags"] = list(self.tags)
            self._tags_dirty = False
        if self._last_hist:
            delta["hist"] = self._last_hist
            self._last_hist = None
        return delta if len(delta) > 1 else None

    def _broadcast(self) -> None:
        delta = self._build_delta()
        if delta is None:
            return
        for cb in list(self._sync_listeners):
            try:
                cb(delta)
            except Exception:  # noqa: BLE001
                log.exception("sync listener failed")

    def mark_dirty(self, tid: str) -> None:
        self._dirty.add(tid)

    # -------------------------------------------------------------- logging
    def _log(self, level: str, msg: str) -> None:
        self._log_id += 1
        item = {"id": self._log_id, "time": time.time(), "level": level, "msg": msg}
        self.log.append(item)
        getattr(log, "warning" if level == "warning" else "error" if level == "error" else "info")(msg)
        if level in ("warning", "error"):
            self.emit("log", item)

    def log_since(self, after: int) -> list[dict[str, Any]]:
        # A client that has seen more than we logged saw an earlier run: it gets everything.
        if after > self._log_id:
            after = 0
        return [x for x in self.log if x["id"] > after]

    # ------------------------------------------------------- alert handlers
    def _entry_for(self, handle: Any) -> Entry | None:
        try:
            return self.entries.get(torrent_id(handle.info_hashes()))
        except RuntimeError:
            return None

    def _on_add_torrent_alert(self, a: Any) -> None:
        if a.error.value():
            name = a.torrent_name or "torrent"
            self._log("warning", f"Could not load {name}: {a.error.message()}")
            return
        h = a.handle
        tid = torrent_id(h.info_hashes())
        if tid in self.entries or tid in self.probes:
            return
        meta = TorrentMeta.from_dict(self._metas.get(tid))
        e = Entry(tid, h, meta)
        self._register(e)

    def _register(self, e: Entry) -> None:
        h = e.handle
        st = h.status(STATUS_FLAGS)
        e.status = st
        e.prev_finished = st.is_finished
        self._refresh_static(e)
        if not e.meta.addedOn:
            e.meta.addedOn = int(st.added_time or time.time())
        if not e.meta.savePath:
            e.meta.savePath = st.save_path
        self.entries[e.id] = e
        self._metas[e.id] = e.meta.to_dict()
        self._meta_dirty = True
        for tag in e.meta.tags:
            if tag not in self.tags:
                self.tags.append(tag)
                self._tags_dirty = True
        if e.meta.category and e.meta.category not in self.categories:
            self.categories[e.meta.category] = {"savePath": ""}
            self._cats_dirty = True
            self._save_categories()
        self._dirty.add(e.id)

    def _refresh_trackers(self, e: Entry) -> None:
        hosts: list[str] = []
        try:
            for t in e.handle.trackers():
                host = urllib.parse.urlsplit(t["url"]).hostname or ""
                if host and host not in hosts:
                    hosts.append(host)
        except (RuntimeError, ValueError):
            return
        e.tracker_hosts = hosts
        self._dirty.add(e.id)

    def _refresh_static(self, e: Entry) -> None:
        self._refresh_trackers(e)
        ti = e.handle.torrent_file()
        e.has_metadata = ti is not None
        if ti is not None:
            fs = ti.layout()
            e.name = ti.name()
            e.total_size = fs.total_size()
            pad = int(fs.flag_pad_file)
            e.num_files = sum(1 for i in range(fs.num_files()) if not fs.file_flags(i) & pad)
            e.is_private = bool(ti.priv())

    def _on_state_update_alert(self, a: Any) -> None:
        for st in a.status:
            tid = torrent_id(st.info_hashes)
            e = self.entries.get(tid)
            if e is None:
                continue
            e.status = st
            if st.errc.value():
                e.error, e.missing_files = error_message(st)
            elif e.error:
                e.error, e.missing_files = "", False
                self._forget_errors(tid)
            if e.moving and not st.moving_storage:
                e.moving = False
            self._dirty.add(tid)

    def _on_session_stats_alert(self, a: Any) -> None:
        v = a.values
        now = time.monotonic()
        prev = self._stats_prev
        recv = v.get("net.recv_payload_bytes", 0)
        sent = v.get("net.sent_payload_bytes", 0)
        recv_all = v.get("net.recv_bytes", 0) + v.get("net.recv_ip_overhead_bytes", 0)
        sent_all = v.get("net.sent_bytes", 0) + v.get("net.sent_ip_overhead_bytes", 0)
        dl = ul = dl_all = ul_all = 0
        if prev is not None:
            elapsed = max(0.05, now - self._stats_time)
            dl = int(max(0, recv - prev["recv"]) / elapsed)
            ul = int(max(0, sent - prev["sent"]) / elapsed)
            dl_all = int(max(0, recv_all - prev["recv_all"]) / elapsed)
            ul_all = int(max(0, sent_all - prev["sent_all"]) / elapsed)
            self._totals["dl"] += max(0, recv - prev["recv"])
            self._totals["ul"] += max(0, sent - prev["sent"])
        self._stats_prev = {"recv": recv, "sent": sent, "recv_all": recv_all, "sent_all": sent_all}
        self._stats_time = now

        if not self.ses.is_listening():
            conn = "disconnected"
        elif v.get("net.has_incoming_connections", 0):
            conn = "connected"
        else:
            conn = "firewalled"
        s = self.prefs["speed"]
        settings_dl = s["altDlLimit"] if self.alt_speed else s["dlLimit"]
        settings_ul = s["altUpLimit"] if self.alt_speed else s["upLimit"]
        self.server = {
            "dlSpeed": dl,
            "upSpeed": ul,
            "dlSpeedTotal": dl_all,
            "upSpeedTotal": ul_all,
            "dlSession": recv,
            "upSession": sent,
            "dlAllTime": self._totals["dl"],
            "upAllTime": self._totals["ul"],
            "dhtNodes": v.get("dht.dht_nodes", 0),
            "peers": v.get("peer.num_peers_connected", 0),
            "connection": conn,
            "freeSpace": self._free_space,
            "altSpeed": self.alt_speed,
            "dlLimit": settings_dl,
            "upLimit": settings_ul,
            "listenPort": self.listen_port or self.prefs["connection"]["port"],
            "externalIp": self.external_ip,
            "wasted": v.get("net.recv_redundant_bytes", 0) + v.get("net.recv_failed_bytes", 0),
            "diskQueue": v.get("disk.queued_write_bytes", 0),
            "diskJobs": v.get("disk.queued_disk_jobs", 0),
            "uptime": int(time.time() - self.started),
        }
        # At most one point per second: the history holds speedHistoryMinutes * 60 of them,
        # however short the refresh interval is.
        second = int(time.time())
        if not self.history or self.history[-1][0] != second:
            point = (second, dl, ul)
            self.history.append(point)
            self._last_hist = point
        self._broadcast()

    def _on_metadata_received_alert(self, a: Any) -> None:
        h = a.handle
        tid = torrent_id(h.info_hashes())
        probe = self.probes.get(tid)
        if probe is not None:
            probe.ti = h.torrent_file()
            info = describe_ti(probe.ti)
            self.emit("metadata", {"token": probe.token, "info": info})
            return
        e = self.entries.get(tid)
        if e is None:
            return
        self._refresh_static(e)
        ti = h.torrent_file()
        meta = e.meta
        if meta.pendingLayout:
            for idx, path in layout_renames(ti, meta.pendingLayout).items():
                h.rename_file(idx, path)
            meta.pendingLayout = ""
        prios = list(meta.pendingPriorities) if meta.pendingPriorities else None
        excluded = excluded_priorities(ti, self.prefs["downloads"]["excludedFileNames"])
        if excluded:
            prios = prios or e.file_priorities()
            for idx in excluded:
                if idx < len(prios):
                    prios[idx] = 0
        if prios:
            self._prioritize(e, prios)
            meta.pendingPriorities = []
        if meta.firstLastPiece:
            self._apply_first_last(e)
        if meta.stopCondition == "metadata":
            h.unset_flags(TF.auto_managed)
            h.pause()
            meta.stopCondition = "none"
        self._meta_changed(e)
        self._save_resume(e)
        self._log("info", f"Metadata received: {e.display_name()}")
        self.emit("torrent.metadata", {"id": tid})

    def _on_torrent_finished_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None:
            return
        h = e.handle
        st = h.status()
        e.status = st
        was_finished = e.prev_finished
        e.prev_finished = True
        meta = e.meta
        dl = self.prefs["downloads"]
        if meta.downloadPath and os.path.normcase(os.path.abspath(st.save_path)) == \
                os.path.normcase(os.path.abspath(meta.downloadPath)) and meta.savePath:
            self._log("info", f"Moving '{e.display_name()}' to {meta.savePath}")
            e.moving = True
            h.move_storage(meta.savePath, lt.move_flags_t.dont_replace)
        if not was_finished and not meta.notifiedComplete and st.total_wanted_done > 0:
            meta.notifiedComplete = True
            self._meta_changed(e)
            self._log("info", f"Download completed: {e.display_name()}")
            self.emit("torrent.finished", {"id": e.id, "name": e.display_name()})
            if dl["recheckOnCompletion"]:
                h.force_recheck()
            if dl["copyFinishedTorrentTo"]:
                self._copy_torrent_file(e, dl["copyFinishedTorrentTo"])
            if dl["runOnFinished"]:
                run_external(dl["runOnFinished"], self._placeholders(e))
        self._save_resume(e)
        self._dirty.add(e.id)

    def _on_torrent_checked_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None:
            return
        if e.meta.stopCondition == "checked":
            e.meta.stopCondition = "none"
            self._meta_changed(e)
        if e.missing_files:
            e.missing_files = False
        self._dirty.add(e.id)

    def _on_save_resume_data_alert(self, a: Any) -> None:
        try:
            tid = torrent_id(a.handle.info_hashes())
        except RuntimeError:
            return
        if tid in self.probes or (tid not in self.entries and not self._closing):
            return
        try:
            buf = lt.write_resume_data_buf(a.params)
            atomic_write_bytes(self.torrents_dir / f"{tid}.fastresume", bytes(buf))
        except OSError as e:
            log.warning("could not write resume data for %s: %s", tid, e)

    def _on_torrent_removed_alert(self, a: Any) -> None:
        tid = torrent_id(a.info_hashes)
        ev = self._removal_events.pop(tid, None)
        if ev is not None:
            ev.set()

    def _on_storage_moved_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None:
            return
        e.moving = False
        new_path = a.storage_path() if callable(getattr(a, "storage_path", None)) else a.path
        if e.meta.downloadPath and os.path.normcase(os.path.abspath(new_path)) == \
                os.path.normcase(os.path.abspath(e.meta.savePath or "")):
            e.meta.downloadPath = ""
        self._meta_changed(e)
        self._save_resume(e)
        self._log("info", f"Moved '{e.display_name()}' to {new_path}")

    def _on_storage_moved_failed_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        name = e.display_name() if e else a.torrent_name
        if e:
            e.moving = False
            self._dirty.add(e.id)
        msg = f"Could not move '{name}': {a.error.message()} ({a.file_path() if callable(a.file_path) else a.file_path})"
        self._log("error", msg)
        self.emit("toast", {"kind": "error", "message": msg})

    def _on_torrent_error_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None:
            return
        msg = a.error.message()
        e.error = msg
        self._dirty.add(e.id)
        if self._torrent_errors.get(e.id) == msg:
            return
        self._torrent_errors[e.id] = msg
        # A file error was already logged, with the file name.
        if e.id not in self._file_errors:
            self._log("error", f"'{e.display_name()}': {e.error}")
        if self.prefs["behavior"]["notifyOnError"]:
            self.emit("torrent.error", {"id": e.id, "name": e.display_name(), "message": e.error})

    def _on_file_error_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        fname = a.filename() if callable(getattr(a, "filename", None)) else getattr(a, "filename", "")
        msg = f"File error in '{a.torrent_name}': {a.error.message()} ({fname})"
        if e is not None:
            if self._file_errors.get(e.id) == msg:
                return
            self._file_errors[e.id] = msg
        self._log("error", msg)

    def _clear_error(self, e: Entry) -> None:
        if e.error:
            e.handle.clear_error()
            e.error, e.missing_files = "", False
        self._forget_errors(e.id)

    def _forget_errors(self, tid: str) -> None:
        self._file_errors.pop(tid, None)
        self._torrent_errors.pop(tid, None)

    def _on_file_completed_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None or not e.meta.appendExtension:
            return
        idx = int(a.index)
        paths = details.file_paths(e)
        if idx < len(paths) and paths[idx].endswith(INCOMPLETE_EXT):
            e.handle.rename_file(idx, paths[idx][: -len(INCOMPLETE_EXT)])

    def _on_file_prio_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is None:
            return
        e.prio_jobs = max(0, e.prio_jobs - 1)
        # Once the last change has landed, libtorrent's own list is the truth again.
        if e.prio_jobs == 0 or list(e.handle.get_file_priorities()) == e.prio_wanted:
            e.prio_wanted = None
            e.prio_jobs = 0
        # libtorrent recomputes piece priorities from file priorities when a change lands,
        # which drops the first/last piece boost.
        if e.meta.firstLastPiece:
            self._apply_first_last(e)
        self._save_resume(e)
        self._files_changed.add(e.id)

    def _on_file_renamed_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        if e is not None:
            old, new = a.old_name, a.new_name
            self._remove_left_folders(e, old() if callable(old) else old, new() if callable(new) else new)
            self._save_resume(e)
            self._files_changed.add(e.id)

    def _remove_left_folders(self, e: Entry, old: str, new: str) -> None:
        """Renaming "a/b/c" to "d/b/c" moves the file and leaves "a/b" behind: remove the
        folders the file left, as far up as they are empty (rmdir refuses anything else)."""
        old_dirs = posixpath.dirname(old.replace("\\", "/")).split("/")
        new_dirs = posixpath.dirname(new.replace("\\", "/")).split("/")
        common = 0
        while common < min(len(old_dirs), len(new_dirs)) and old_dirs[common] == new_dirs[common]:
            common += 1
        save = e.status.save_path if e.status is not None else e.meta.savePath
        for depth in range(len(old_dirs), common, -1):
            if not old_dirs[depth - 1]:
                break
            try:
                os.rmdir(os.path.join(save, *old_dirs[:depth]))
            except OSError:
                break

    def _on_file_rename_failed_alert(self, a: Any) -> None:
        e = self._entry_for(a.handle)
        msg = f"Could not rename file in '{a.torrent_name}': {a.error.message()}"
        self._log("warning", msg)
        if e is not None:
            self._files_changed.add(e.id)
        self.emit("toast", {"kind": "error", "message": msg})

    def _on_fastresume_rejected_alert(self, a: Any) -> None:
        self._log("warning", f"Resume data rejected for '{a.torrent_name}': {a.error.message()} — rechecking")

    def _on_listen_succeeded_alert(self, a: Any) -> None:
        self.listen_port = a.port
        self._log("info", f"Listening on {a.address}:{a.port} ({a.socket_type.name if hasattr(a.socket_type, 'name') else a.socket_type})")

    def _on_listen_failed_alert(self, a: Any) -> None:
        self._log("error", f"Could not listen on {a.address}:{a.port}: {a.error.message()}")

    def _on_portmap_alert(self, a: Any) -> None:
        self._log("info", f"Port forwarding succeeded: {a.message()}")

    def _on_portmap_error_alert(self, a: Any) -> None:
        self._log("info", f"Port forwarding failed: {a.message()}")

    def _on_external_ip_alert(self, a: Any) -> None:
        self.external_ip = str(a.external_address)
        self._log("info", f"External IP detected: {self.external_ip}")

    _BLOCK_REASONS = {0: "IP filter", 1: "Port filter", 2: "I2P mixed mode", 3: "Privileged port",
                      4: "uTP disabled", 5: "TCP disabled", 6: "Invalid local interface", 7: "SSRF mitigation"}

    def _on_peer_blocked_alert(self, a: Any) -> None:
        ip = a.ip[0] if isinstance(a.ip, tuple) else a.ip  # the bindings give (address, port)
        key = (str(ip), self._BLOCK_REASONS.get(int(a.reason), "Blocked"))
        now = time.time()
        entry = self._blocked_recent.get(key)
        if entry is not None and now - entry["time"] < 60:
            entry["count"] += 1
            entry["last"] = now
            return
        if len(self._blocked_recent) > 2000:
            self._blocked_recent = {k: v for k, v in self._blocked_recent.items() if now - v["time"] < 60}
        entry = {"time": now, "last": now, "ip": key[0], "reason": key[1], "count": 1}
        self._blocked_recent[key] = entry
        self.blocked.append(entry)

    def _on_performance_alert(self, a: Any) -> None:
        # These are tuning hints, not faults: log each kind at most every 10 minutes.
        key = str(getattr(a, "warning_code", a.message()))
        now = time.monotonic()
        if now - self._perf_seen.get(key, -1e9) < 600:
            return
        self._perf_seen[key] = now
        self._log("info", f"Performance: {a.message()}")

    def _on_alerts_dropped_alert(self, a: Any) -> None:
        log.warning("libtorrent dropped alerts")

    def _on_dht_bootstrap_alert(self, a: Any) -> None:
        self._log("info", "DHT bootstrapped")

    def _on_torrent_delete_failed_alert(self, a: Any) -> None:
        self._log("warning", f"Could not delete files of '{a.torrent_name}': {a.error.message()}")

    # ----------------------------------------------------------- persistence
    def _meta_changed(self, e: Entry) -> None:
        self._metas[e.id] = e.meta.to_dict()
        self._meta_dirty = True
        self._dirty.add(e.id)

    def _save_meta(self, force: bool = False) -> None:
        for tid, e in self.entries.items():
            if force:
                try:
                    e.meta.queuePos = int(e.handle.queue_position())
                except RuntimeError:
                    pass
            elif e.status is not None:
                e.meta.queuePos = e.status.queue_position
            self._metas[tid] = e.meta.to_dict()
        try:
            atomic_write_json(self.data_dir / "torrents.json", self._metas)
            self._meta_dirty = False
        except OSError as e:
            log.warning("could not save torrent metadata: %s", e)

    def _save_categories(self) -> None:
        atomic_write_json(self.data_dir / "categories.json", self.categories)

    def _save_tags(self) -> None:
        atomic_write_json(self.data_dir / "tags.json", self.tags)

    def _save_stats(self) -> None:
        try:
            atomic_write_json(self.data_dir / "stats.json", self._totals)
        except OSError:
            pass

    def _save_resume(self, e: Entry) -> None:
        try:
            e.handle.save_resume_data(lt.save_resume_flags_t.save_info_dict)
        except RuntimeError:
            pass

    # --------------------------------------------------------- HTTP fetching
    async def _client(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=60),
                headers={"User-Agent": f"Promethea/{__version__}"},
            )
        return self._http

    async def fetch_url(self, url: str) -> tuple[str, bytes | str]:
        """Download a .torrent URL. Returns ("bytes", data) or ("magnet", uri)."""
        http = await self._client()
        current = url
        for _ in range(10):
            async with http.get(current, allow_redirects=False) as resp:
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location", "")
                    if not loc:
                        raise SourceError("redirect without location")
                    if is_magnet(loc):
                        return "magnet", loc
                    current = str(resp.url.join(aiohttp.client.URL(loc)))
                    continue
                if resp.status >= 400:
                    raise SourceError(f"download failed: HTTP {resp.status}")
                data = bytearray()
                async for chunk in resp.content.iter_chunked(65536):
                    data += chunk
                    if len(data) > 50 * 1024 * 1024:
                        raise SourceError("torrent file is too large")
                return "bytes", bytes(data)
        raise SourceError("too many redirects")

    # ------------------------------------------------------- adding torrents
    def _require_session(self) -> None:
        if self.ses is None or self._closing:
            raise SourceError("the engine is shutting down")

    async def add_text(self, text: str, opts: AddOptions) -> str:
        """Add a magnet link, info hash, http(s) URL or local .torrent path."""
        self._require_session()
        text = text.strip()
        if is_info_hash(text):
            text = f"magnet:?xt=urn:btih:{text}"
        if is_magnet(text):
            return self._add_atp(load_magnet(text), opts, magnet=text)
        if text.lower().startswith(("http://", "https://")):
            kind, payload = await self.fetch_url(text)
            if kind == "magnet":
                return self._add_atp(load_magnet(str(payload)), opts, magnet=str(payload))
            return self._add_atp(load_torrent_bytes(payload), opts)  # type: ignore[arg-type]
        path = text[7:] if text.lower().startswith("file://") else text
        if os.path.isfile(path):
            data = await asyncio.get_running_loop().run_in_executor(None, Path(path).read_bytes)
            tid = self._add_atp(load_torrent_bytes(data), opts)
            if self.prefs["downloads"]["deleteTorrentFile"]:
                delete_paths([path])
            return tid
        raise SourceError("not a magnet link, URL or torrent file")

    async def add_bytes(self, data: bytes, opts: AddOptions) -> str:
        self._require_session()
        return self._add_atp(load_torrent_bytes(data), opts)

    async def inspect(self, *, data: bytes | None = None, text: str | None = None) -> dict[str, Any]:
        """Parse a source for the add dialog; magnets start a metadata probe."""
        self._require_session()
        token = uuid.uuid4().hex
        path = ""
        if text is not None:
            text = text.strip()
            if is_info_hash(text):
                text = f"magnet:?xt=urn:btih:{text}"
            if text.lower().startswith(("http://", "https://")):
                kind, payload = await self.fetch_url(text)
                if kind == "magnet":
                    text = str(payload)
                else:
                    data, text = payload, None  # type: ignore[assignment]
            elif not is_magnet(text):
                p = text[7:] if text.lower().startswith("file://") else text
                if os.path.isfile(p):
                    data = await asyncio.get_running_loop().run_in_executor(None, Path(p).read_bytes)
                    path, text = p, None
                else:
                    raise SourceError("not a magnet link, URL or torrent file")
        if data is not None:
            atp = load_torrent_bytes(data)
            info = describe_ti(atp.ti, atp)
            self.pending[token] = Pending("bytes", data=data, path=path)
        else:
            assert text is not None
            atp = load_magnet(text)
            info = describe_magnet(atp)
            self.pending[token] = Pending("magnet", magnet=text)
            tid = info["id"]
            if tid not in self.entries:
                self._start_probe(token, tid, text)
        existing = self.entries.get(info["id"])
        info["token"] = token
        info["alreadyAdded"] = existing is not None
        if existing is not None:
            info["existingName"] = existing.display_name()
            info["existingPrivate"] = existing.is_private
        return info

    def _start_probe(self, token: str, tid: str, magnet: str) -> None:
        old = self.probes.get(tid)
        if old is not None:
            old.token = token
            if old.ti is not None:
                loop = asyncio.get_running_loop()
                info = describe_ti(old.ti)
                loop.call_soon(lambda: self.emit("metadata", {"token": token, "info": info}))
            return
        atp = load_magnet(magnet)
        self.probe_dir.mkdir(parents=True, exist_ok=True)
        atp.save_path = str(self.probe_dir)
        flags = int(atp.flags) | int(TF.upload_mode) | int(TF.default_dont_download)
        flags &= ~(PAUSED | AUTO_MANAGED)
        atp.flags = flags
        atp.max_connections = 100
        h = self.ses.add_torrent(atp)
        self.probes[tid] = Probe(token, tid, h, magnet)

    def _drop_probe(self, tid: str) -> Probe | None:
        probe = self.probes.pop(tid, None)
        if probe is not None:
            try:
                self.ses.remove_torrent(probe.handle)
            except RuntimeError:
                pass
        return probe

    def cancel_pending(self, token: str) -> None:
        pend = self.pending.pop(token, None)
        if pend is None or pend.kind != "magnet":
            return
        for tid, probe in list(self.probes.items()):
            if probe.token == token:
                self._drop_probe(tid)

    def _expire_pending(self) -> None:
        now = time.monotonic()
        for token, pend in list(self.pending.items()):
            if now - pend.created > 3600:
                self.cancel_pending(token)
        for tid, probe in list(self.probes.items()):
            if now - probe.created > 3600:
                self._drop_probe(tid)

    async def add_pending(self, token: str, opts: AddOptions) -> str:
        self._require_session()
        pend = self.pending.pop(token, None)
        if pend is None:
            raise SourceError("this add request expired; please add the torrent again")
        if pend.kind == "bytes":
            tid = self._add_atp(load_torrent_bytes(pend.data), opts)
            if pend.path and self.prefs["downloads"]["deleteTorrentFile"]:
                delete_paths([pend.path])
            return tid
        atp = load_magnet(pend.magnet)
        tid = torrent_id(atp.info_hashes)
        probe = self.probes.get(tid)
        if probe is not None and probe.ti is not None:
            atp.ti = probe.ti
        self._drop_probe(tid)
        return self._add_atp(atp, opts, magnet=pend.magnet)

    def _add_atp(self, atp: Any, opts: AddOptions, magnet: str | None = None) -> str:
        p = self.prefs
        dlp = p["downloads"]
        ti = atp.ti
        tid = torrent_id(ti.info_hashes() if ti is not None else atp.info_hashes)
        existing = self.entries.get(tid)
        if existing is not None:
            trackers, seeds = self._merge_sources(existing, atp)
            raise DuplicateTorrent(tid, existing.display_name(), trackers, seeds)
        if tid in self.probes:
            probe = self._drop_probe(tid)
            if ti is None and probe is not None and probe.ti is not None:
                atp.ti = ti = probe.ti

        category = (opts.category or "").strip()
        if category and category not in self.categories:
            self.categories[category] = {"savePath": ""}
            self._cats_dirty = True
            self._save_categories()
        auto_tmm = opts.autoTMM if opts.autoTMM is not None else dlp["autoTMM"]
        if auto_tmm:
            save_path = self.category_save_path(category)
        else:
            save_path = (opts.savePath or "").strip() or dlp["savePath"]
        use_dl = opts.useDownloadPath if opts.useDownloadPath is not None else dlp["useIncompletePath"]
        download_path = ((opts.downloadPath or "").strip() or dlp["incompletePath"]) if use_dl else ""
        if opts.skipChecking:
            download_path = ""
        atp.save_path = download_path or save_path

        flags = int(atp.flags)
        flags &= ~(PAUSED | AUTO_MANAGED | SEQUENTIAL | int(TF.upload_mode) | int(TF.stop_when_ready)
                   | int(TF.seed_mode) | int(TF.default_dont_download))
        paused = opts.paused if opts.paused is not None else dlp["startPaused"]
        stop_cond = opts.stopCondition or dlp["stopCondition"]
        if paused:
            flags |= PAUSED
        else:
            flags |= AUTO_MANAGED
        flags |= int(TF.duplicate_is_error)
        if opts.sequential:
            flags |= SEQUENTIAL
        if opts.skipChecking and ti is not None:
            flags |= int(TF.seed_mode)
        if stop_cond == "checked" and not paused:
            flags |= int(TF.stop_when_ready)
        atp.flags = flags
        atp.storage_mode = lt.storage_mode_t.storage_mode_allocate if dlp["preallocate"] else \
            lt.storage_mode_t.storage_mode_sparse
        atp.download_limit = int(opts.dlLimit) if opts.dlLimit and opts.dlLimit > 0 else -1
        atp.upload_limit = int(opts.upLimit) if opts.upLimit and opts.upLimit > 0 else -1
        c = p["connection"]
        atp.max_connections = c["maxConnectionsPerTorrent"] if c["maxConnectionsPerTorrent"] > 0 else -1
        atp.max_uploads = c["maxUploadsPerTorrent"] if c["maxUploadsPerTorrent"] > 0 else -1

        b = p["bittorrent"]
        # Private torrents must only talk to their own tracker (a magnet's privacy isn't known yet).
        private = ti is not None and ti.priv()
        if b["addTrackersEnabled"] and b["addTrackers"].strip() and not private:
            existing_trackers = list(atp.trackers)
            tiers = list(atp.tracker_tiers) if len(atp.tracker_tiers) == len(existing_trackers) else [0] * len(existing_trackers)
            next_tier = (max(tiers) + 1) if tiers else 0
            for url in (u.strip() for u in b["addTrackers"].splitlines()):
                if url and url not in existing_trackers:
                    existing_trackers.append(url)
                    tiers.append(next_tier)
                    next_tier += 1
            atp.trackers = existing_trackers
            atp.tracker_tiers = tiers

        layout = opts.contentLayout or dlp["contentLayout"]
        comment, created_by, created_on = file_fields(atp)
        meta = TorrentMeta(
            category=category,
            tags=[t for t in dict.fromkeys(x.strip() for x in opts.tags) if t],
            name=(opts.name or "").strip(),
            savePath=save_path,
            downloadPath=download_path,
            autoTMM=bool(auto_tmm),
            ratioLimit=float(opts.ratioLimit),
            seedingTimeLimit=int(opts.seedingTimeLimit),
            inactiveSeedingTimeLimit=int(opts.inactiveSeedingTimeLimit),
            firstLastPiece=bool(opts.firstLast),
            stopCondition=stop_cond if stop_cond != "checked" else ("checked" if not paused else "none"),
            addedOn=int(time.time()),
            source=opts.source,
            comment=comment,
            createdBy=created_by,
            creationDate=created_on,
            appendExtension=bool(dlp["appendExtension"]),
        )
        if ti is not None:
            renames = layout_renames(ti, layout)
            if opts.renames:
                renames.update({int(k): v for k, v in opts.renames.items()})
            n = ti.layout().num_files()
            prios = None
            fp = opts.filePriorities
            if isinstance(fp, dict) and fp:
                prios = [4] * n
                for idx, prio in fp.items():
                    if 0 <= int(idx) < n:
                        prios[int(idx)] = max(0, min(7, int(prio)))
            elif isinstance(fp, list) and len(fp) == n:
                prios = [max(0, min(7, int(x))) for x in fp]
            # The add dialog already applied the excluded names (and the user may have overridden them).
            excluded = {} if fp else excluded_priorities(ti, dlp["excludedFileNames"])
            if excluded:
                prios = prios or [4] * n
                for idx in excluded:
                    prios[idx] = 0
            if meta.appendExtension and not opts.skipChecking:
                paths = {f["index"]: f["path"] for f in files_of(ti)}
                for idx, path in paths.items():
                    if prios is None or prios[idx] > 0:
                        renames[idx] = renames.get(idx, path) + INCOMPLETE_EXT
            if renames:
                atp.renamed_files = renames
            if prios:
                atp.file_priorities = prios
        else:
            if layout != "original":
                meta.pendingLayout = layout
            if stop_cond == "metadata" and not paused:
                meta.stopCondition = "metadata"
            if isinstance(opts.filePriorities, list) and opts.filePriorities:
                meta.pendingPriorities = [int(x) for x in opts.filePriorities]

        try:
            h = self.ses.add_torrent(atp)
        except RuntimeError as err:
            raise SourceError(str(err)) from None
        e = Entry(tid, h, meta)
        self._register(e)
        if opts.addToTop if opts.addToTop is not None else dlp["addToTop"]:
            h.queue_position_top()
        if meta.firstLastPiece and e.has_metadata:
            self._apply_first_last(e)
        for tag in meta.tags:
            if tag not in self.tags:
                self.tags.append(tag)
                self.tags.sort(key=str.lower)
                self._tags_dirty = True
                self._save_tags()
        self._save_meta()
        self._save_resume(e)
        if dlp["copyTorrentTo"] and e.has_metadata:
            self._copy_torrent_file(e, dlp["copyTorrentTo"])
        if dlp["runOnAdded"]:
            run_external(dlp["runOnAdded"], self._placeholders(e))
        self._log("info", f"Added: {e.display_name()}")
        self.emit("torrent.added", {"id": tid, "name": e.display_name()})
        return tid

    def _merge_sources(self, e: Entry, atp: Any) -> tuple[int, int]:
        """Adding a torrent that already exists merges its trackers and web seeds.

        Returns how many new trackers and web seeds it took (none for a private torrent).
        """
        if e.is_private:
            return 0, 0
        have = {t["url"] for t in e.handle.trackers()}
        tiers = list(atp.tracker_tiers)
        trackers = 0
        for i, url in enumerate(atp.trackers):
            if url not in have:
                e.handle.add_tracker({"url": url, "tier": tiers[i] if i < len(tiers) else 0})
                have.add(url)
                trackers += 1
        seeds = 0
        have_seeds = set(e.handle.url_seeds())
        for url in atp.url_seeds:
            if url not in have_seeds:
                e.handle.add_url_seed(url)
                have_seeds.add(url)
                seeds += 1
        if trackers:
            self._refresh_trackers(e)
        if trackers or seeds:
            self._log("info", f"Merged {trackers} tracker(s) and {seeds} web seed(s) into '{e.display_name()}'")
        return trackers, seeds

    def _copy_torrent_file(self, e: Entry, folder: str) -> None:
        try:
            data = torrent_file_bytes(e.handle)
            name = "".join(c for c in e.display_name() if c not in '<>:"/\\|?*') or e.id
            atomic_write_bytes(Path(folder) / f"{name}.torrent", data)
        except (OSError, SourceError) as err:
            self._log("warning", f"Could not copy .torrent for '{e.display_name()}': {error_text(err)}")

    def _placeholders(self, e: Entry) -> dict[str, str]:
        st = e.handle.status()
        ih = e.handle.info_hashes()
        save = st.save_path
        paths = [p for _, p in details.real_files(e)]
        root = ""
        if paths and all("/" in x for x in paths) and len({x.split("/", 1)[0] for x in paths}) == 1:
            root = os.path.join(save, paths[0].split("/", 1)[0])
        content = root or (os.path.join(save, paths[0]) if len(paths) == 1 else save)
        return {
            "N": e.display_name(),
            "L": e.meta.category,
            "G": ",".join(e.meta.tags),
            "F": content,
            "R": root,
            "D": save,
            "C": str(e.num_files),
            "Z": str(st.total_wanted),
            "T": st.current_tracker,
            "I": str(ih.v1) if ih.has_v1() else "-",
            "J": str(ih.v2) if ih.has_v2() else "-",
            "K": e.id,
        }

    # ------------------------------------------------------------ queries
    def get(self, tid: str) -> Entry:
        e = self.entries.get(tid)
        if e is None:
            raise NotFound(tid)
        return e

    def _each(self, ids: list[str]) -> list[Entry]:
        return [self.entries[t] for t in ids if t in self.entries]

    def category_save_path(self, category: str) -> str:
        base = self.prefs["downloads"]["savePath"]
        if not category:
            return base
        sp = (self.categories.get(category) or {}).get("savePath", "") or ""
        if sp:
            return sp if os.path.isabs(sp) else os.path.join(base, sp)
        return os.path.join(base, *category.split("/"))

    def categories_public(self) -> dict[str, Any]:
        return {name: {"savePath": c.get("savePath", ""), "resolvedPath": self.category_save_path(name)}
                for name, c in sorted(self.categories.items(), key=lambda kv: kv[0].lower())}

    # ------------------------------------------------------------ actions
    def start(self, ids: list[str]) -> None:
        for e in self._each(ids):
            h = e.handle
            self._clear_error(e)
            h.unset_flags(TF.upload_mode)
            h.set_flags(TF.auto_managed)
            h.resume()
            self._dirty.add(e.id)

    def force_start(self, ids: list[str]) -> None:
        for e in self._each(ids):
            h = e.handle
            self._clear_error(e)
            h.unset_flags(TF.auto_managed | TF.upload_mode)
            h.resume()
            self._dirty.add(e.id)

    def stop(self, ids: list[str]) -> None:
        for e in self._each(ids):
            e.handle.unset_flags(TF.auto_managed)
            e.handle.pause()
            self._dirty.add(e.id)

    def start_all(self) -> None:
        self.start(list(self.entries))

    def stop_all(self) -> None:
        self.stop(list(self.entries))

    def recheck(self, ids: list[str]) -> None:
        for e in self._each(ids):
            self._clear_error(e)
            e.handle.force_recheck()
            self._dirty.add(e.id)

    def reannounce(self, ids: list[str]) -> None:
        for e in self._each(ids):
            e.handle.force_reannounce(0, -1, lt.reannounce_flags_t.ignore_min_interval)
            if not e.is_private:
                e.handle.force_dht_announce()

    def queue(self, ids: list[str], op: str) -> None:
        entries = [e for e in self._each(ids) if e.status is not None]
        # Process in the order that keeps the selection's relative order intact.
        entries.sort(key=lambda e: e.status.queue_position, reverse=op in ("top", "down"))
        for e in entries:
            fn = {"top": e.handle.queue_position_top, "up": e.handle.queue_position_up,
                  "down": e.handle.queue_position_down, "bottom": e.handle.queue_position_bottom}[op]
            fn()
            self._dirty.add(e.id)
        self._meta_dirty = True

    def set_flag(self, ids: list[str], flag: str, value: bool) -> None:
        for e in self._each(ids):
            h = e.handle
            if flag == "sequential":
                (h.set_flags if value else h.unset_flags)(TF.sequential_download)
            elif flag == "superSeeding":
                (h.set_flags if value else h.unset_flags)(TF.super_seeding)
            elif flag == "firstLast":
                e.meta.firstLastPiece = value
                if e.has_metadata:
                    self._apply_first_last(e, reset=not value)
                self._meta_changed(e)
            else:
                raise ValueError(f"unknown flag {flag}")
            self._dirty.add(e.id)
            self._save_resume(e)

    def _apply_first_last(self, e: Entry, reset: bool = False) -> None:
        h = e.handle
        ti = h.torrent_file()
        if ti is None:
            return
        fs = ti.layout()
        plen = ti.piece_length()
        prios = list(h.get_piece_priorities())
        file_prios = e.file_priorities()
        pad = int(fs.flag_pad_file)
        for i in range(fs.num_files()):
            if fs.file_flags(i) & pad or fs.file_size(i) == 0:
                continue
            fprio = file_prios[i] if i < len(file_prios) else 4
            if fprio == 0:
                continue
            first = fs.file_offset(i) // plen
            last = (fs.file_offset(i) + fs.file_size(i) - 1) // plen
            # Prioritize ~1% of the file at each end (at least one piece), like qBittorrent.
            span = max(1, int((last - first + 1) * 0.01))
            for piece in list(range(first, min(last, first + span - 1) + 1)) + list(range(max(first, last - span + 1), last + 1)):
                if 0 <= piece < len(prios):
                    prios[piece] = fprio if reset else 7
        h.prioritize_pieces(prios)

    def set_category(self, ids: list[str], category: str) -> None:
        category = category.strip()
        if category and category not in self.categories:
            self.categories[category] = {"savePath": ""}
            self._cats_dirty = True
            self._save_categories()
        for e in self._each(ids):
            if e.meta.category == category:
                continue
            e.meta.category = category
            if e.meta.autoTMM:
                self._relocate(e, self.category_save_path(category))
            self._meta_changed(e)

    def set_tags(self, ids: list[str], tags: list[str], mode: str) -> None:
        tags = [t.strip() for t in tags if t and t.strip()]
        new_tags = [t for t in tags if t not in self.tags]
        if new_tags:
            self.tags.extend(new_tags)
            self.tags.sort(key=str.lower)
            self._tags_dirty = True
            self._save_tags()
        for e in self._each(ids):
            cur = list(e.meta.tags)
            if mode == "add":
                cur += [t for t in tags if t not in cur]
            elif mode == "remove":
                cur = [t for t in cur if t not in tags]
            else:
                cur = list(dict.fromkeys(tags))
            if cur != e.meta.tags:
                e.meta.tags = cur
                self._meta_changed(e)

    def set_limits(self, ids: list[str], dl: int | None, ul: int | None) -> None:
        for e in self._each(ids):
            if dl is not None:
                e.handle.set_download_limit(int(dl) if dl > 0 else -1)
            if ul is not None:
                e.handle.set_upload_limit(int(ul) if ul > 0 else -1)
            self._dirty.add(e.id)
            self._save_resume(e)

    def set_share_limits(self, ids: list[str], ratio: float, seeding: int, inactive: int) -> None:
        for e in self._each(ids):
            e.meta.ratioLimit = float(ratio)
            e.meta.seedingTimeLimit = int(seeding)
            e.meta.inactiveSeedingTimeLimit = int(inactive)
            e.meta.seedLimitHandled = False
            self._meta_changed(e)

    def set_auto_tmm(self, ids: list[str], enabled: bool) -> None:
        for e in self._each(ids):
            e.meta.autoTMM = enabled
            if enabled:
                self._relocate(e, self.category_save_path(e.meta.category))
            self._meta_changed(e)

    def set_location(self, ids: list[str], path: str) -> None:
        path = path.strip()
        if not path:
            raise ValueError("location cannot be empty")
        for e in self._each(ids):
            e.meta.autoTMM = False
            e.meta.downloadPath = ""
            self._relocate(e, path)
            self._meta_changed(e)

    def _relocate(self, e: Entry, path: str) -> None:
        e.meta.savePath = path
        cur = e.status.save_path if e.status is not None else ""
        if e.meta.downloadPath and not e.is_finished():
            return  # still downloading into the incomplete folder; moves on completion
        if os.path.normcase(os.path.abspath(cur)) != os.path.normcase(os.path.abspath(path)):
            e.moving = True
            e.handle.move_storage(path, lt.move_flags_t.dont_replace)
            self._dirty.add(e.id)

    def rename(self, tid: str, name: str) -> None:
        e = self.get(tid)
        e.meta.name = name.strip()
        self._meta_changed(e)

    def rename_path(self, tid: str, old: str, new: str) -> None:
        """Rename a file, or a folder (every file under it), inside a torrent."""
        e = self.get(tid)
        old = old.strip("/")
        new = new.strip("/")
        if not old or not new:
            raise ValueError("invalid name")
        if any(part in ("", ".", "..") for part in new.split("/")):
            raise ValueError("invalid name")
        renamed = 0
        for idx, path in details.real_files(e):
            # The UI shows names without the incomplete-file extension; keep it on unfinished files.
            if path == old or path == old + INCOMPLETE_EXT:
                e.handle.rename_file(idx, new + path[len(old):])
                renamed += 1
            elif path.startswith(old + "/"):
                e.handle.rename_file(idx, new + path[len(old):])
                renamed += 1
        if not renamed:
            raise ValueError("path not found in torrent")

    def _prioritize(self, e: Entry, prios: list[int]) -> None:
        e.prio_wanted = list(prios)
        e.prio_jobs += 1
        e.handle.prioritize_files(prios)

    def set_file_priority(self, tid: str, indices: list[int], priority: int) -> None:
        e = self.get(tid)
        prios = e.file_priorities()
        for i in indices:
            if 0 <= i < len(prios):
                prios[i] = max(0, min(7, int(priority)))
        self._prioritize(e, prios)
        if e.meta.firstLastPiece:
            self._apply_first_last(e)
        if e.meta.appendExtension:
            self._manage_extension(e, prios)
        self._save_resume(e)
        self._dirty.add(e.id)

    def _manage_extension(self, e: Entry, prios: list[int]) -> None:
        progress = e.handle.file_progress()
        ti = e.handle.torrent_file()
        if ti is None:
            return
        fs = ti.layout()
        for idx, path in details.real_files(e):
            complete = progress[idx] >= fs.file_size(idx)
            wanted = prios[idx] > 0 if idx < len(prios) else True
            has_ext = path.endswith(INCOMPLETE_EXT)
            if wanted and not complete and not has_ext:
                e.handle.rename_file(idx, path + INCOMPLETE_EXT)
            elif (complete or not wanted) and has_ext:
                e.handle.rename_file(idx, path[: -len(INCOMPLETE_EXT)])

    def edit_trackers(self, tid: str, add: list[str], remove: list[str], edit: dict[str, str]) -> None:
        e = self.get(tid)
        trackers = [{"url": t["url"], "tier": int(t.get("tier", 0))} for t in e.handle.trackers()]
        urls = {t["url"] for t in trackers}
        if remove:
            trackers = [t for t in trackers if t["url"] not in set(remove)]
        for old, new in edit.items():
            new = new.strip()
            for t in trackers:
                if t["url"] == old and new and new not in urls:
                    t["url"] = new
                    urls.discard(old)
                    urls.add(new)
        # Added trackers go after the existing ones. Consecutive URLs share a tier and an
        # empty entry starts the next one (the blank-line convention of tracker lists).
        tier = max((t["tier"] for t in trackers), default=-1) + 1
        used = False
        for url in add:
            url = url.strip()
            if not url:
                if used:
                    tier += 1
                    used = False
            elif url not in urls:
                trackers.append({"url": url, "tier": tier})
                urls.add(url)
                used = True
        e.handle.replace_trackers(trackers)
        self._refresh_trackers(e)
        if add or edit:
            e.handle.force_reannounce(0, -1, lt.reannounce_flags_t.ignore_min_interval)
        self._save_resume(e)

    def edit_web_seeds(self, tid: str, add: list[str], remove: list[str]) -> None:
        e = self.get(tid)
        for url in remove:
            e.handle.remove_url_seed(url)
            e.handle.remove_http_seed(url)
        for url in add:
            if url.strip():
                e.handle.add_url_seed(url.strip())
        self._save_resume(e)

    def add_peers(self, tid: str, peers: list[str]) -> int:
        e = self.get(tid)
        ok = 0
        for p in peers:
            p = p.strip()
            if not p:
                continue
            host, _, port = p.rpartition(":")
            host = host.strip("[]")
            try:
                e.handle.connect_peer((host, int(port)))
                ok += 1
            except (ValueError, RuntimeError):
                continue
        return ok

    def ban_peers(self, ips: list[str]) -> None:
        banned = list(self.prefs["connection"]["bannedIPs"])
        for ip in ips:
            ip = ip.strip()
            if ip and ip not in banned:
                banned.append(ip)
        self.prefs.update({"connection": {"bannedIPs": banned}}, local=True)
        self._apply_ip_filter()

    def _apply_ip_filter(self) -> None:
        c = self.prefs["connection"]
        ranges: list[tuple[str, str]] = []
        if c["ipFilterEnabled"] and c["ipFilterPath"]:
            try:
                ranges = parse_filter_file(c["ipFilterPath"])
            except (OSError, ValueError) as e:
                self._log("warning", f"Could not load IP filter: {error_text(e)}")
        f, count = build_filter(ranges, c["bannedIPs"])
        self.ses.set_ip_filter(f)
        if ranges:
            self._log("info", f"IP filter loaded: {count} rules")

    async def remove(self, ids: list[str], delete_files: bool) -> None:
        use_bin = delete_files and IS_WINDOWS and self.prefs["behavior"]["useRecycleBin"]
        for e in self._each(ids):
            self.entries.pop(e.id, None)
            self._forget_errors(e.id)
            self._metas.pop(e.id, None)
            self._removed.append(e.id)
            self._dirty.discard(e.id)
            e.removing = True
            name = e.display_name()
            try:
                (self.torrents_dir / f"{e.id}.fastresume").unlink(missing_ok=True)
            except OSError:
                pass
            if use_bin and e.has_metadata:
                save = e.status.save_path if e.status is not None else e.meta.savePath
                files = [os.path.join(save, *p.split("/")) for _, p in details.real_files(e)]
                ih = e.handle.info_hashes()
                part = os.path.join(save, f".{ih.v1 if ih.has_v1() else str(ih.v2)[:40]}.parts")
                ev = asyncio.Event()
                self._removal_events[e.id] = ev
                self.ses.remove_torrent(e.handle)
                asyncio.get_running_loop().create_task(self._recycle_later(name, ev, save, files, part))
            else:
                flag = lt.options_t.delete_files if delete_files else 0
                self.ses.remove_torrent(e.handle, flag)
            self._log("info", f"Removed: {name}" + (" (and its files)" if delete_files else ""))
        self._meta_dirty = True

    async def _recycle_later(self, name: str, ev: asyncio.Event, save: str, files: list[str], part: str) -> None:
        try:
            await asyncio.wait_for(ev.wait(), 10)
        except asyncio.TimeoutError:
            pass
        loop = asyncio.get_running_loop()
        for attempt in range(5):
            await asyncio.sleep(0.4 * (attempt + 1))
            ok = await loop.run_in_executor(None, recycle, files)
            if ok:
                break
        else:
            self._log("warning", f"Could not move files of '{name}' to the Recycle Bin")
            self.emit("toast", {"kind": "error", "message": f"Could not move files of '{name}' to the Recycle Bin"})
            return
        await loop.run_in_executor(None, delete_paths, [part])
        for d in sorted({os.path.dirname(f) for f in files}, key=len, reverse=True):
            await loop.run_in_executor(None, remove_empty_dirs, d, save)

    # ----------------------------------------------------- categories/tags
    def set_category_def(self, name: str, save_path: str, old_name: str | None = None) -> None:
        name = name.strip()
        if not name or name.startswith("/") or name.endswith("/") or "//" in name:
            raise ValueError("invalid category name")
        if old_name and old_name != name:
            if old_name not in self.categories:
                raise NotFound(old_name)
            if name in self.categories:
                raise ValueError("a category with that name already exists")
            self.categories[name] = self.categories.pop(old_name)
            for e in self.entries.values():
                if e.meta.category == old_name:
                    e.meta.category = name
                    self._meta_changed(e)
        old_path = self.category_save_path(name) if name in self.categories else None
        self.categories[name] = {"savePath": save_path.strip()}
        self._cats_dirty = True
        self._save_categories()
        new_path = self.category_save_path(name)
        if old_path is not None and old_path != new_path:
            for e in self.entries.values():
                if e.meta.category == name and e.meta.autoTMM:
                    self._relocate(e, new_path)
                    self._meta_changed(e)

    def delete_categories(self, names: list[str]) -> None:
        for name in names:
            self.categories.pop(name, None)
            for e in self.entries.values():
                if e.meta.category == name:
                    e.meta.category = ""
                    if e.meta.autoTMM:
                        self._relocate(e, self.category_save_path(""))
                    self._meta_changed(e)
        self._cats_dirty = True
        self._save_categories()

    def create_tags(self, tags: list[str]) -> None:
        for t in tags:
            t = t.strip()
            if t and t not in self.tags:
                self.tags.append(t)
        self.tags.sort(key=str.lower)
        self._tags_dirty = True
        self._save_tags()

    def delete_tags(self, tags: list[str]) -> None:
        drop = set(tags)
        self.tags = [t for t in self.tags if t not in drop]
        for e in self.entries.values():
            if drop & set(e.meta.tags):
                e.meta.tags = [t for t in e.meta.tags if t not in drop]
                self._meta_changed(e)
        self._tags_dirty = True
        self._save_tags()

    # ------------------------------------------------------- speed / prefs
    def set_alt_speed(self, enabled: bool) -> None:
        if enabled == self.alt_speed:
            return
        self.alt_speed = enabled
        self.prefs.update({"speed": {"altEnabled": enabled}}, local=True)
        self.ses.apply_settings(self.settings())
        self._log("info", "Alternative speed limits " + ("on" if enabled else "off"))

    def set_global_limits(self, dl: int | None, ul: int | None) -> None:
        key_dl, key_ul = ("altDlLimit", "altUpLimit") if self.alt_speed else ("dlLimit", "upLimit")
        patch: dict[str, Any] = {}
        if dl is not None:
            patch[key_dl] = max(0, int(dl))
        if ul is not None:
            patch[key_ul] = max(0, int(ul))
        self.prefs.update({"speed": patch}, local=True)
        self.ses.apply_settings(self.settings())

    def apply_prefs(self, changed: set[tuple[str, str]]) -> None:
        sections = {s for s, _ in changed}
        if ("speed", "altEnabled") in changed:
            self.alt_speed = self.prefs["speed"]["altEnabled"]
        self.ses.apply_settings(self.settings())
        if {("connection", "ipFilterEnabled"), ("connection", "ipFilterPath"),
                ("connection", "bannedIPs")} & changed:
            self._apply_ip_filter()
        if {("connection", "maxConnectionsPerTorrent"), ("connection", "maxUploadsPerTorrent")} & changed:
            c = self.prefs["connection"]
            for e in self.entries.values():
                e.handle.set_max_connections(c["maxConnectionsPerTorrent"] if c["maxConnectionsPerTorrent"] > 0 else -1)
                e.handle.set_max_uploads(c["maxUploadsPerTorrent"] if c["maxUploadsPerTorrent"] > 0 else -1)
        if ("downloads", "savePath") in changed:
            for e in self.entries.values():
                if e.meta.autoTMM:
                    self._relocate(e, self.category_save_path(e.meta.category))
                    self._meta_changed(e)
            self._cats_dirty = True
        if "bittorrent" in sections:
            for e in self.entries.values():
                e.meta.seedLimitHandled = False
        if ("speed", "scheduleEnabled") in changed:
            self._schedule_state = None
        for e in self.entries.values():
            self._dirty.add(e.id)

    # --------------------------------------------------- periodic checks
    def _check_seeding_limits(self) -> None:
        g_ratio, g_seed, g_inactive = self._globals()
        action = self.prefs["bittorrent"]["seedingLimitAction"]
        to_remove: list[str] = []
        to_remove_files: list[str] = []
        for e in list(self.entries.values()):
            st = e.status
            if st is None or e.meta.seedLimitHandled or not e.is_finished() or e.is_stopped():
                continue
            m = e.meta
            ratio_limit = g_ratio if m.ratioLimit == -2 else m.ratioLimit
            seed_limit = g_seed if m.seedingTimeLimit == -2 else m.seedingTimeLimit
            inactive_limit = g_inactive if m.inactiveSeedingTimeLimit == -2 else m.inactiveSeedingTimeLimit
            reached = ""
            if ratio_limit >= 0 and ratio_of(st) >= ratio_limit:
                reached = f"ratio {ratio_of(st):.2f}"
            seeding_minutes = (st.seeding_duration.total_seconds() if hasattr(st.seeding_duration, "total_seconds")
                               else float(st.seeding_duration or 0)) / 60
            if not reached and seed_limit >= 0 and seeding_minutes >= seed_limit:
                reached = f"seeding time {int(seeding_minutes)} min"
            if not reached and inactive_limit >= 0:
                idle = st.time_since_upload if st.time_since_upload >= 0 else seeding_minutes * 60
                if idle / 60 >= inactive_limit:
                    reached = f"inactive for {int(idle / 60)} min"
            if not reached:
                continue
            m.seedLimitHandled = True
            self._meta_changed(e)
            name = e.display_name()
            if action == "stop":
                self.stop([e.id])
                self._log("info", f"Stopped '{name}': reached {reached}")
            elif action == "superSeeding":
                e.handle.set_flags(TF.super_seeding)
                self._log("info", f"Super seeding '{name}': reached {reached}")
            elif action == "remove":
                to_remove.append(e.id)
                self._log("info", f"Removing '{name}': reached {reached}")
            elif action == "removeWithFiles":
                to_remove_files.append(e.id)
                self._log("info", f"Removing '{name}' and its files: reached {reached}")
        loop = asyncio.get_running_loop()
        if to_remove:
            loop.create_task(self.remove(to_remove, False))
        if to_remove_files:
            loop.create_task(self.remove(to_remove_files, True))

    def _check_schedule(self) -> None:
        s = self.prefs["speed"]
        if not s["scheduleEnabled"]:
            return
        now = dt.datetime.now()
        days = s["scheduleDays"]
        wd = now.weekday()
        day_ok = (days == "every" or (days == "weekdays" and wd < 5) or (days == "weekends" and wd >= 5)
                  or days == ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][wd])
        try:
            f_h, f_m = (int(x) for x in s["scheduleFrom"].split(":"))
            t_h, t_m = (int(x) for x in s["scheduleTo"].split(":"))
        except ValueError:
            return
        cur = now.hour * 60 + now.minute
        start, end = f_h * 60 + f_m, t_h * 60 + t_m
        in_window = (start <= cur < end) if start <= end else (cur >= start or cur < end)
        active = day_ok and in_window
        if active != self._schedule_state:
            self._schedule_state = active
            if active != self.alt_speed:
                self.set_alt_speed(active)

    def _update_sleep(self) -> None:
        if not self.prefs["behavior"]["preventSleep"]:
            self._sleep.set(False)
            return
        busy = any(
            e.status is not None and not e.is_paused() and not e.is_finished()
            and e.status.state in (lt.torrent_status.states.downloading, lt.torrent_status.states.downloading_metadata)
            for e in self.entries.values()
        )
        self._sleep.set(busy)

    async def _refresh_free_space(self) -> None:
        path = self.prefs["downloads"]["savePath"]
        self._free_space = await asyncio.get_running_loop().run_in_executor(None, free_space, path)

    async def _scan_watched(self) -> None:
        folders = self.prefs["downloads"]["watchedFolders"]
        if not folders:
            return
        loop = asyncio.get_running_loop()
        for wf in folders:
            folder = wf.get("path") if isinstance(wf, dict) else None
            if not folder:
                continue
            try:
                names = await loop.run_in_executor(None, _list_torrents, folder)
            except OSError:
                continue
            for path, size, mtime in names:
                prev = self._watch_seen.get(path)
                self._watch_seen[path] = (size, mtime)
                if prev != (size, mtime) or time.time() - mtime < 2:
                    continue  # wait until the file stops changing
                self._watch_seen.pop(path, None)
                opts = AddOptions(
                    savePath=wf.get("savePath") or None,
                    category=wf.get("category") or None,
                    paused=wf.get("paused"),
                    source="watched",
                )
                try:
                    data = await loop.run_in_executor(None, Path(path).read_bytes)
                    self._add_atp(load_torrent_bytes(data), opts)
                    suffix = ".added"
                except DuplicateTorrent:
                    suffix = ".added"
                except SourceError as e:
                    self._log("warning", f"Watched folder: could not add {os.path.basename(path)}: {e}")
                    suffix = ".invalid"
                except OSError:
                    continue
                target = path + suffix
                n = 1
                while os.path.exists(target):
                    target = f"{path}{suffix}.{n}"
                    n += 1
                try:
                    os.replace(path, target)
                except OSError:
                    pass

    # -------------------------------------------------------- torrent creator
    def create_torrent(self, source: str, output: str, opts: dict[str, Any]) -> CreateJob:
        loop = asyncio.get_running_loop()

        def on_update(job: CreateJob) -> None:
            # Read here, in the hashing thread: by the time the loop runs the callback the job
            # may have moved on, and a late progress update mustn't report it finished twice.
            loop.call_soon_threadsafe(self._on_job_update, job, job.public(), opts)

        # Finished jobs are kept for the UI to show, but not forever.
        done = [j for j in self.jobs.values() if j.status != "running"]
        for j in sorted(done, key=lambda j: j.started)[:max(0, len(done) - 20)]:
            del self.jobs[j.id]
        job = start_job(source, output, opts, on_update)
        self.jobs[job.id] = job
        return job

    async def inspect_source(self, source: str, opts: dict[str, Any]) -> dict[str, Any]:
        """Size, file count and pieces of a torrent made from `source`. A newer call cuts an
        older one short, so typing a path doesn't leave walks of half-typed folders running."""
        self._inspect_gen += 1
        gen = self._inspect_gen
        return await asyncio.get_running_loop().run_in_executor(
            None, creator_inspect, source, opts, lambda: gen != self._inspect_gen)

    def _on_job_update(self, job: CreateJob, state: dict[str, Any], opts: dict[str, Any]) -> None:
        self.emit("creator", state)
        if state["status"] == "done" and job.result_bytes and job.seed:
            job_bytes, job.result_bytes = job.result_bytes, b""
            no_limit = -1 if opts.get("ignoreShareLimits") else -2
            try:
                self._add_atp(load_torrent_bytes(job_bytes), AddOptions(
                    savePath=os.path.dirname(os.path.abspath(job.source)), useDownloadPath=False,
                    skipChecking=True, paused=False, stopCondition="none", source="creator",
                    autoTMM=False, contentLayout="original", ratioLimit=no_limit,
                    seedingTimeLimit=no_limit, inactiveSeedingTimeLimit=no_limit))
            except DuplicateTorrent as e:
                # Its trackers and web seeds were merged into the one that's there.
                self.emit("toast", {"kind": "info", "message": str(e)})
            except (SourceError, RuntimeError, OSError) as e:
                msg = f"Could not start seeding the new torrent: {error_text(e)}"
                self._log("warning", msg)
                self.emit("toast", {"kind": "error", "message": msg})
        elif state["status"] != "running":
            job.result_bytes = b""


def _destroy(holder: list) -> None:
    holder.clear()


def _list_torrents(folder: str) -> list[tuple[str, int, float]]:
    out = []
    with os.scandir(folder) as it:
        for entry in it:
            if entry.is_file() and entry.name.lower().endswith(".torrent"):
                st = entry.stat()
                out.append((entry.path, st.st_size, st.st_mtime))
    return out
