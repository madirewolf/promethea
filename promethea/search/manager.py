"""Torrent search: manages qBittorrent-compatible (nova3) plugins and runs searches.

Every plugin call runs in its own Python subprocess (``nova/runner.py``) so a
slow, hanging or crashing plugin can never take the app down with it.

Layout under ``data_dir``::

    engines/<name>.py      plugin source (+ optional <name>.png / <name>.ico icon)
    plugins.json           {name: {"enabled": bool, "cache": {...plugin info...}}}
    tmp/                   .torrent files fetched by plugins' download_torrent()
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import functools
import json
import keyword
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiohttp

from ..util import atomic_write_bytes, atomic_write_json, error_text, read_json
from .nova.novaprinter import anySizeToBytes
from .nova.runner import read_plugin_version

__all__ = ["CATEGORIES", "NotFoundError", "SearchManager"]

log = logging.getLogger(__name__)

#: Category ids understood by nova3 plugins, with display names.
CATEGORIES: dict[str, str] = {
    "all": "All categories",
    "anime": "Anime",
    "books": "Books",
    "games": "Games",
    "movies": "Movies",
    "music": "Music",
    "pictures": "Pictures",
    "software": "Software",
    "tv": "TV shows",
}

OFFICIAL_PLUGINS_URL = "https://raw.githubusercontent.com/qbittorrent/search-plugins/master/nova3/engines/"

MAX_PLUGIN_BYTES = 2 * 1024 * 1024
MAX_ICON_BYTES = 256 * 1024
MAX_RESULTS_PER_SEARCH = 50_000
MAX_KEPT_SEARCHES = 64
MAX_QUERY_LENGTH = 1000
FLUSH_INTERVAL = 0.25  # seconds between "search.results" events of one search
TMP_MAX_AGE = 24 * 3600
LINE_LIMIT = 1 << 20  # longer plugin output lines are dropped whole

_RUNNER = Path(__file__).resolve().parent / "nova" / "runner.py"
_IS_WINDOWS = sys.platform == "win32"
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_CATEGORY_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_RESERVED_NAMES = frozenset({"engines", "helpers", "nova2", "nova2dl", "novaprinter", "runner", "socks"})
_GITHUB_BLOB_RE = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", re.IGNORECASE)


class NotFoundError(KeyError, ValueError):
    """Unknown search id or plugin name (catchable as KeyError or ValueError)."""

    def __str__(self) -> str:
        return str(self.args[0]) if self.args else ""


# --------------------------------------------------------------------------- helpers


def _valid_name(name: str) -> bool:
    return bool(_NAME_RE.match(name)) and not keyword.iskeyword(name) and name not in _RESERVED_NAMES


def _plugin_name_from_filename(filename: str) -> str:
    base = re.split(r"[\\/]", filename.strip())[-1]
    if not base.lower().endswith(".py"):
        raise ValueError("Search plugins are Python files ending in .py")
    name = base[:-3]
    if not _valid_name(name):
        raise ValueError(
            f"'{base}' is not a valid plugin file name (use letters, digits and underscores, "
            "starting with a letter)"
        )
    return name


def _check_source(content: bytes) -> None:
    if not content.strip():
        raise ValueError("The plugin file is empty")
    if len(content) > MAX_PLUGIN_BYTES:
        raise ValueError("The plugin file is larger than 2 MB")
    if b"\x00" in content:
        raise ValueError("This is not a Python source file")
    if content.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"<"):
        raise ValueError("Got an HTML page instead of a Python plugin (link to the raw .py file)")


def _version_key(version: str | None) -> tuple[int, ...]:
    parts: list[int] = []
    for piece in (version or "").strip().split("."):
        match = re.match(r"\d+", piece)
        if not match:
            break
        parts.append(int(match.group()))
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _parse_versions_txt(text: str) -> dict[str, str]:
    versions: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":")
        if len(parts) != 2:
            continue
        name, version = parts[0].strip(), parts[1].strip()
        if name and _version_key(version):
            versions[name] = version
    return versions


def _icon_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"\x00\x00\x01\x00":
        return "image/x-icon"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return None


def _parse_count(text: str) -> int:
    text = text.strip()
    try:
        value = int(text)
    except ValueError:
        try:
            value = int(float(text.replace(",", "")))
        except (ValueError, OverflowError):
            return -1
    return value if value >= 0 else -1


def _parse_pub_date(text: str) -> int:
    try:
        value = int(float(text.strip()))
    except (ValueError, OverflowError):
        return 0
    return value if value > 0 else 0


def _parse_result_line(raw: bytes, plugin: str) -> dict[str, Any] | None:
    """Turn one ``link|name|size|seeds|leech|engine_url|desc_link|pub_date`` line into a result."""
    parts = raw.decode("utf-8", "replace").strip("\r\n").split("|")
    if len(parts) < 6:
        return None
    link, name = parts[0].strip(), parts[1].strip()
    if not link or not name:
        return None
    return {
        "name": name,
        "link": link,
        "size": anySizeToBytes(parts[2].strip()),
        "seeds": _parse_count(parts[3]),
        "leechers": _parse_count(parts[4]),
        "engineUrl": parts[5].strip(),
        "descLink": parts[6].strip() if len(parts) > 6 else "",
        "pubDate": _parse_pub_date(parts[7]) if len(parts) > 7 else 0,
        "plugin": plugin,
    }


def _summarize_stderr(text: str) -> str:
    """The most useful line of a plugin's stderr (the exception line of a traceback)."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    message = lines[-1]
    return message if len(message) <= 500 else message[:497] + "..."


def _parse_download_output(lines: list[bytes], url: str) -> str | None:
    """Find the torrent source in ``"<path> <url>"`` output (paths may contain spaces)."""
    for raw in reversed(lines):
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        candidates = [line]
        if line.endswith(" " + url):
            candidates.append(line[: -len(url) - 1].strip())
        if " " in line:
            candidates.append(line.rsplit(" ", 1)[0].strip())
            candidates.append(line.split(" ", 1)[0])
        for candidate in candidates:
            if candidate.lower().startswith("magnet:") and " " not in candidate:
                return candidate
            if os.path.isfile(candidate):
                return str(Path(candidate).resolve())
        for candidate in candidates[1:]:
            if candidate.lower().startswith(("http://", "https://")) and " " not in candidate:
                return candidate
    return None


def _normalize_info(data: Any, name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("invalid plugin info")
    supported = data.get("supported")
    if supported is not None:
        supported = sorted({str(key) for key in supported})
    categories = {str(key) for key in data.get("categories") or [] if str(key) and str(key) != "all"}
    return {
        "name": str(data.get("name") or name),
        "url": str(data.get("url") or ""),
        "categories": sorted(categories, key=str.lower),
        "supported": supported,
        "version": str(data.get("version") or ""),
        "download": bool(data.get("download")),
    }


def _resolve_python(python_exe: str | None) -> str | None:
    exe = python_exe
    if not exe:
        if getattr(sys, "frozen", False):
            # The frozen app runs plugins itself, with the Python it bundles (see _spawn).
            exe = sys.executable
        else:
            exe = sys.executable or shutil.which("python3") or shutil.which("python")
    if exe and Path(exe).name.lower() == "pythonw.exe":
        console = Path(exe).with_name("python.exe")
        if console.is_file():
            exe = str(console)
    return exe or None


def _retry_on_lock(func: Callable[..., Any], *args: Any) -> Any:
    """Windows refuses to replace/delete a file another process has open; retry briefly."""
    for attempt in range(5):
        try:
            return func(*args)
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))
    return None


def _unlink(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        _retry_on_lock(os.unlink, path)


# --------------------------------------------------------------------------- child processes


class _TailBuffer:
    """Keeps the last ``limit`` bytes written to it (thread-safe)."""

    def __init__(self, limit: int = 64 * 1024) -> None:
        self._data = bytearray()
        self._limit = limit
        self._lock = threading.Lock()

    def add(self, chunk: bytes) -> None:
        with self._lock:
            self._data += chunk
            if len(self._data) > self._limit:
                del self._data[: len(self._data) - self._limit]

    def text(self) -> str:
        with self._lock:
            return self._data.decode("utf-8", "replace")


def _kill(pid: int, fallback: Callable[[], None]) -> None:
    if not _IS_WINDOWS:
        try:
            os.killpg(pid, signal.SIGKILL)  # the child leads its own session
            return
        except OSError:
            pass
    with contextlib.suppress(OSError):
        fallback()


class _AsyncChild:
    """A runner subprocess driven by asyncio's subprocess support."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self.pid = proc.pid
        self._stderr = _TailBuffer()
        self._stderr_task = asyncio.ensure_future(self._drain_stderr())
        self._eof = False

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    async def _drain_stderr(self) -> None:
        stream = self._proc.stderr
        assert stream is not None
        with contextlib.suppress(Exception):
            while chunk := await stream.read(65536):
                self._stderr.add(chunk)

    async def readline(self) -> bytes:
        """The next stdout line (b"" at EOF). Lines over LINE_LIMIT are skipped whole."""
        if self._eof:
            return b""
        stream = self._proc.stdout
        assert stream is not None
        skipping = False
        while True:
            try:
                line = await stream.readuntil(b"\n")
            except asyncio.IncompleteReadError as exc:  # EOF, maybe after a last line without "\n"
                self._eof = True
                return b"" if skipping else bytes(exc.partial)
            except asyncio.LimitOverrunError as exc:
                # Discard what is buffered and keep discarding up to the line's "\n";
                # StreamReader.readline() would hand that tail back as a line of its own.
                with contextlib.suppress(asyncio.IncompleteReadError):
                    await stream.readexactly(exc.consumed)
                skipping = True
                continue
            except (OSError, RuntimeError, ValueError):
                self._eof = True
                return b""
            if skipping:
                skipping = False
                continue
            return line

    async def wait(self) -> int:
        with contextlib.suppress(Exception):
            await self._stderr_task
        return await self._proc.wait()

    def kill(self) -> None:
        if self._proc.returncode is None:
            _kill(self.pid, self._proc.kill)

    def stderr_text(self) -> str:
        return self._stderr.text()


def _resolve_future(future: asyncio.Future[int], value: int) -> None:
    if not future.done():
        future.set_result(value)


class _ThreadChild:
    """Fallback for event loops without subprocess support (Windows SelectorEventLoop)."""

    def __init__(self, popen: subprocess.Popen[bytes], loop: asyncio.AbstractEventLoop) -> None:
        self._popen = popen
        self.pid = popen.pid
        self._loop = loop
        self._lines: asyncio.Queue[bytes] = asyncio.Queue()
        self._stderr = _TailBuffer()
        self._exit: asyncio.Future[int] = loop.create_future()
        self._eof = False
        self._stderr_thread = threading.Thread(target=self._pump_stderr, name=f"search-err-{self.pid}", daemon=True)
        self._stderr_thread.start()
        threading.Thread(target=self._pump_stdout, name=f"search-out-{self.pid}", daemon=True).start()

    @property
    def returncode(self) -> int | None:
        return self._popen.returncode

    def _post(self, callback: Callable[..., Any], *args: Any) -> None:
        with contextlib.suppress(RuntimeError):  # loop already closed
            self._loop.call_soon_threadsafe(callback, *args)

    def _pump_stdout(self) -> None:
        stream = self._popen.stdout
        assert stream is not None
        skipping = False
        try:
            while line := stream.readline(LINE_LIMIT):
                if len(line) >= LINE_LIMIT and not line.endswith(b"\n"):
                    skipping = True  # over-long line: drop it whole, like _AsyncChild
                    continue
                if skipping:
                    skipping = False  # its tail
                    continue
                self._post(self._lines.put_nowait, line)
        except (OSError, ValueError):
            pass
        finally:
            self._post(self._lines.put_nowait, b"")
            with contextlib.suppress(OSError):
                stream.close()
            self._stderr_thread.join(10)
            code = self._popen.wait()
            self._post(_resolve_future, self._exit, code)

    def _pump_stderr(self) -> None:
        stream = self._popen.stderr
        assert stream is not None
        try:
            while chunk := stream.read1(65536):
                self._stderr.add(chunk)
        except (OSError, ValueError):
            pass
        finally:
            with contextlib.suppress(OSError):
                stream.close()

    async def readline(self) -> bytes:
        if self._eof:
            return b""
        line = await self._lines.get()
        if not line:
            self._eof = True
        return line

    async def wait(self) -> int:
        return await asyncio.shield(self._exit)

    def kill(self) -> None:
        if self._popen.poll() is None:
            _kill(self.pid, self._popen.kill)

    def stderr_text(self) -> str:
        return self._stderr.text()


_Child = _AsyncChild | _ThreadChild


async def _reap(child: _Child, grace: float) -> None:
    """Drain whatever output is left and wait for the process to exit (bounded)."""
    with contextlib.suppress(Exception):
        async with asyncio.timeout(grace):
            while await child.readline():
                pass
            await child.wait()


# --------------------------------------------------------------------------- state


@dataclass
class _Plugin:
    name: str
    path: Path
    enabled: bool = True
    info: dict[str, Any] | None = None  # None: the plugin failed to load
    error: str | None = None
    version: str = ""
    mtime_ns: int = 0
    size: int = 0
    icon: str | None = None


@dataclass
class _Search:
    id: str
    query: str
    category: str
    plugins: list[str]
    status: str = "running"
    results: list[dict[str, Any]] = field(default_factory=list)
    links: set[str] = field(default_factory=set)
    errors: list[dict[str, str]] = field(default_factory=list)
    pending: list[dict[str, Any]] = field(default_factory=list)
    flush_handle: asyncio.TimerHandle | None = None
    last_flush: float = float("-inf")
    failed: int = 0
    procs: set[Any] = field(default_factory=set)


# --------------------------------------------------------------------------- manager


class SearchManager:
    """Installs nova3 search plugins and runs searches with them.

    All methods must be called from the event-loop thread; ``emit`` is only
    ever called from that thread too.
    """

    #: Per-plugin limits, in seconds (instance attributes may be changed).
    plugin_timeout = 60.0
    info_timeout = 20.0
    download_timeout = 60.0
    #: Plugin processes run at once per search, and in total.
    max_concurrent = 8
    max_processes = 16

    def __init__(self, data_dir: Path, emit: Callable[[str, dict], None], python_exe: str | None = None) -> None:
        self._data_dir = Path(data_dir)
        self._engines_dir = self._data_dir / "engines"
        self._tmp_dir = self._data_dir / "tmp"
        self._state_path = self._data_dir / "plugins.json"
        self._emit_cb = emit
        self._python = _resolve_python(python_exe)
        # PROMETHEA_PLUGIN_REPO: a mirror of the official engines folder (where GitHub is blocked).
        repo = os.environ.get("PROMETHEA_PLUGIN_REPO", "").strip() or OFFICIAL_PLUGINS_URL
        self.plugin_base_url = repo if repo.endswith("/") else repo + "/"
        self.versions_url = self.plugin_base_url + "versions.txt"

        self._plugins: dict[str, _Plugin] = {}
        self._searches: dict[str, _Search] = {}
        self._procs: set[_Child] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._session: aiohttp.ClientSession | None = None
        self._thread_backend = False
        self._started = False
        self._closed = False
        self._start_lock = asyncio.Lock()
        self._install_lock = asyncio.Lock()
        self._process_slots: asyncio.Semaphore | None = None
        self._info_slots: asyncio.Semaphore | None = None

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Create directories and load the installed plugins (cached by file mtime)."""
        async with self._start_lock:
            if self._started:
                return
            self._loop = asyncio.get_running_loop()
            self._process_slots = asyncio.Semaphore(self.max_processes)
            self._info_slots = asyncio.Semaphore(self.max_concurrent)
            self._engines_dir.mkdir(parents=True, exist_ok=True)
            self._tmp_dir.mkdir(parents=True, exist_ok=True)
            self._clean_leftovers()

            state = read_json(self._state_path, {})
            if not isinstance(state, dict):
                state = {}
            stale: list[_Plugin] = []
            for name, path in self._scan_engines().items():
                entry = state.get(name) if isinstance(state.get(name), dict) else {}
                try:
                    stat = path.stat()
                except OSError:
                    continue
                plugin = _Plugin(
                    name=name,
                    path=path,
                    enabled=bool(entry.get("enabled", True)),
                    mtime_ns=stat.st_mtime_ns,
                    size=stat.st_size,
                    icon=self._load_icon(name),
                )
                cache = entry.get("cache")
                if (
                    isinstance(cache, dict)
                    and cache.get("mtime_ns") == stat.st_mtime_ns
                    and cache.get("size") == stat.st_size
                ):
                    try:
                        plugin.info = _normalize_info(cache.get("info"), name)
                        plugin.version = plugin.info["version"]
                    except ValueError:
                        plugin.info = None
                if plugin.info is None:
                    stale.append(plugin)
                self._plugins[name] = plugin
            if stale:
                await asyncio.gather(*(self._refresh_info(plugin) for plugin in stale))
            self._started = True
            self._save_state()
            self._emit("search.plugins", {})

    async def close(self) -> None:
        """Stop every search, kill every plugin process and close the HTTP session."""
        if self._closed:
            return
        self._closed = True
        for search in self._searches.values():
            if search.status == "running":
                search.status = "stopped"
            if search.flush_handle is not None:
                search.flush_handle.cancel()
                search.flush_handle = None
        for child in list(self._procs):
            child.kill()
        pending = [task for task in self._tasks if not task.done()]
        if pending:
            _, still_running = await asyncio.wait(pending, timeout=5)
            for task in still_running:
                task.cancel()
            if still_running:
                await asyncio.wait(still_running, timeout=2)
        for child in list(self._procs):
            child.kill()
            await _reap(child, 2)
        self._procs.clear()
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def _ensure_started(self) -> None:
        if self._closed:
            raise ValueError("The search manager has been shut down")
        if not self._started:
            await self.start()

    # ------------------------------------------------------------------ plugins

    def plugins(self) -> list[dict]:
        """Installed plugins, sorted by name."""
        return [self._plugin_dict(p) for p in sorted(self._plugins.values(), key=lambda p: p.name.lower())]

    async def install_from_url(self, url: str) -> dict:
        """Download a plugin .py (max 2 MB), validate it and install it."""
        await self._ensure_started()
        url = (url or "").strip()
        parts = urllib.parse.urlsplit(url)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            raise ValueError("The plugin URL must start with http:// or https://")
        blob = _GITHUB_BLOB_RE.match(url)
        if blob:  # a GitHub web page link; fetch the raw file instead
            url = f"https://raw.githubusercontent.com/{blob.group(1)}/{blob.group(2)}/{blob.group(3)}"

        content, final_url, filename = await self._http_get(url, MAX_PLUGIN_BYTES, timeout=60, what="plugin")
        name = None
        for candidate in (url, final_url):
            last = urllib.parse.unquote(urllib.parse.urlsplit(candidate).path).rsplit("/", 1)[-1]
            if last.lower().endswith(".py"):
                name = _plugin_name_from_filename(last)
                break
        if name is None:
            if filename and filename.lower().endswith(".py"):
                name = _plugin_name_from_filename(filename)
            else:
                raise ValueError("The URL must point to a plugin's .py file")

        await self._install_source(name, content)
        stem = final_url.split("?", 1)[0]
        if stem.lower().endswith(".py"):
            await self._fetch_icon(name, [stem[:-3] + ".png", stem[:-3] + ".ico"])
        self._emit("search.plugins", {})
        return self._plugin_dict(self._plugins[name])

    async def install_from_file(self, filename: str, content: bytes) -> dict:
        """Validate and install an uploaded plugin file."""
        await self._ensure_started()
        name = _plugin_name_from_filename(filename or "")
        if isinstance(content, str):
            content = content.encode("utf-8")
        await self._install_source(name, bytes(content))
        self._emit("search.plugins", {})
        return self._plugin_dict(self._plugins[name])

    def uninstall(self, names: list[str]) -> None:
        """Remove plugins and their files (``<name>.*``: source, icon, config)."""
        if isinstance(names, str):
            names = [names]
        removed = False
        for name in names:
            name = str(name).strip()
            if self._plugins.pop(name, None) is None:
                continue
            self._delete_plugin_files(name)
            removed = True
        if removed:
            self._save_state()
            self._emit("search.plugins", {})

    def set_enabled(self, name: str, enabled: bool) -> None:
        plugin = self._plugins.get(name)
        if plugin is None:
            raise NotFoundError(f"No search plugin named '{name}' is installed")
        enabled = bool(enabled)
        if plugin.enabled != enabled:
            plugin.enabled = enabled
            self._save_state()
            self._emit("search.plugins", {})

    async def check_updates(self) -> list[dict]:
        """Installed plugins that have a newer version in the official repository."""
        await self._ensure_started()
        data, _, _ = await self._http_get(self.versions_url, 1024 * 1024, timeout=30, what="plugin versions")
        available = _parse_versions_txt(data.decode("utf-8", "replace"))
        updates = []
        for name in sorted(self._plugins, key=str.lower):
            newest = available.get(name)
            installed = self._plugins[name].version
            if newest and _version_key(newest) > _version_key(installed):
                updates.append({"name": name, "installed": installed, "available": newest})
        return updates

    async def official_plugins(self) -> list[dict]:
        """Every plugin in the official repository, and whether it is installed here."""
        await self._ensure_started()
        data, _, _ = await self._http_get(self.versions_url, 1024 * 1024, timeout=30, what="plugin list")
        available = _parse_versions_txt(data.decode("utf-8", "replace"))
        return [
            {"name": name, "version": version, "installed": name in self._plugins}
            for name, version in sorted(available.items(), key=lambda kv: kv[0].lower())
            if _valid_name(name)
        ]

    async def update_plugins(self, names: list[str]) -> list[dict]:
        """(Re)install plugins from the official repository.

        Returns one ``{"name", "ok", "version", "error"}`` entry per requested name.
        """
        await self._ensure_started()
        if isinstance(names, str):
            names = [names]
        wanted = list(dict.fromkeys(str(name).strip() for name in names if str(name).strip()))

        async def fetch(name: str) -> bytes:
            if not _valid_name(name):
                raise ValueError(f"'{name}' is not a valid plugin name")
            data, _, _ = await self._http_get(self.plugin_base_url + name + ".py", MAX_PLUGIN_BYTES, 60, "plugin")
            return data

        downloads = await asyncio.gather(*(fetch(name) for name in wanted), return_exceptions=True)
        results: list[dict] = []
        changed = False
        for name, data in zip(wanted, downloads):
            try:
                if isinstance(data, BaseException):
                    if isinstance(data, ValueError):
                        raise data
                    raise ValueError(str(data) or type(data).__name__)
                await self._install_source(name, data)
                changed = True
                await self._fetch_icon(name, [self.plugin_base_url + name + ".png"])
                results.append({"name": name, "ok": True, "version": self._plugins[name].version, "error": None})
            except ValueError as exc:
                current = self._plugins.get(name)
                results.append(
                    {"name": name, "ok": False, "version": current.version if current else None, "error": str(exc)}
                )
        if changed:
            self._emit("search.plugins", {})
        return results

    # ------------------------------------------------------------------ searches

    async def start_search(self, query: str, category: str = "all", plugins: list[str] | None = None) -> str:
        """Start searching; ``plugins=None`` means every enabled plugin. Returns the search id."""
        await self._ensure_started()
        query = " ".join(str(query or "").split())
        if not query:
            raise ValueError("Enter something to search for")
        if len(query) > MAX_QUERY_LENGTH:
            raise ValueError("The search query is too long")
        category = str(category or "all").strip().lower()
        if not _CATEGORY_RE.match(category):
            raise ValueError(f"Unknown search category: {category!r}")
        if self._python is None:
            raise ValueError("No Python interpreter was found to run search plugins")
        names = self._pick_plugins(plugins, category)

        search = _Search(id=uuid.uuid4().hex[:12], query=query, category=category, plugins=names)
        self._searches[search.id] = search
        self._track(asyncio.get_running_loop().create_task(self._run_search(search), name=f"search-{search.id}"))
        self._prune_searches()
        return search.id

    def stop_search(self, search_id: str) -> None:
        """Stop a running search (no-op for unknown or finished searches)."""
        search = self._searches.get(search_id)
        if search is None or search.status != "running":
            return
        search.status = "stopped"
        for child in list(search.procs):
            child.kill()
        self._flush(search)
        self._emit_status(search)

    def remove_search(self, search_id: str) -> None:
        """Forget a search, stopping it first (no-op for unknown ids)."""
        search = self._searches.pop(search_id, None)
        if search is None:
            return
        if search.status == "running":
            search.status = "stopped"
            for child in list(search.procs):
                child.kill()
        if search.flush_handle is not None:
            search.flush_handle.cancel()
            search.flush_handle = None
        search.pending.clear()

    def get_search(self, search_id: str, offset: int = 0) -> dict:
        search = self._searches.get(search_id)
        if search is None:
            raise NotFoundError(f"Unknown search id: {search_id}")
        try:
            offset = max(0, int(offset))
        except (TypeError, ValueError):
            offset = 0
        return {
            "id": search.id,
            "query": search.query,
            "category": search.category,
            "status": search.status,
            "total": len(search.results),
            "results": search.results[offset:],
            "errors": list(search.errors),
            "plugins": list(search.plugins),
        }

    def searches(self) -> list[dict]:
        return [
            {"id": s.id, "query": s.query, "category": s.category, "status": s.status, "total": len(s.results)}
            for s in self._searches.values()
        ]

    async def download_link(self, plugin: str, url: str) -> str:
        """Resolve a result link to something the engine can add.

        Magnets and links of plugins without ``download_torrent()`` come back
        unchanged; otherwise the plugin downloads the torrent and the local
        .torrent path (or the magnet/URL it produced) is returned.
        """
        await self._ensure_started()
        url = (url or "").strip()
        if not url:
            raise ValueError("The result has no download link")
        if url.lower().startswith("magnet:"):
            return url
        entry = self._plugins.get(plugin)
        if entry is None or entry.info is None or not entry.info.get("download"):
            return url
        if self._python is None:
            raise ValueError("No Python interpreter was found to run search plugins")

        lines: list[bytes] = []
        try:
            child = await self._spawn(["download", str(self._engines_dir), plugin, url], self._engines_dir)
        except OSError as exc:
            raise ValueError(f"Could not start the '{plugin}' plugin: {exc}") from None
        code = await self._communicate(child, self.download_timeout, lambda line: len(lines) < 1000 and lines.append(line))
        if code is None:
            raise ValueError(f"The '{plugin}' plugin did not finish downloading within {self.download_timeout:g} s")
        if code != 0:
            reason = _summarize_stderr(child.stderr_text()) or f"exit code {code}"
            raise ValueError(f"The '{plugin}' plugin could not download the torrent: {reason}")
        source = _parse_download_output(lines, url)
        if source is None:
            raise ValueError(f"The '{plugin}' plugin did not return a torrent file")
        return source

    # ------------------------------------------------------------------ search internals

    def _pick_plugins(self, plugins: list[str] | str | None, category: str) -> list[str]:
        usable = {name: p for name, p in self._plugins.items() if p.info is not None}
        if plugins is None:
            chosen = [name for name, p in usable.items() if p.enabled]
            if not chosen:
                raise ValueError("No search plugins are enabled" if self._plugins else "No search plugins are installed")
        else:
            if isinstance(plugins, str):
                plugins = re.split(r"[,|]", plugins)
            wanted = list(dict.fromkeys(str(n).strip() for n in plugins if str(n).strip()))
            if wanted == ["all"] and "all" not in self._plugins:
                chosen = list(usable)
            elif wanted == ["enabled"] and "enabled" not in self._plugins:
                chosen = [name for name, p in usable.items() if p.enabled]
            else:
                chosen = [name for name in wanted if name in usable]
            if not chosen:
                raise ValueError("None of the selected search plugins are available")
        names = [
            name for name in chosen
            if usable[name].info.get("supported") is None or category in usable[name].info["supported"]
        ]
        if not names:
            label = CATEGORIES.get(category, category)
            raise ValueError(f"None of the selected search plugins support the '{label}' category")
        return sorted(names, key=str.lower)

    async def _run_search(self, search: _Search) -> None:
        slots = asyncio.Semaphore(self.max_concurrent)
        try:
            outcomes = await asyncio.gather(
                *(self._run_plugin(search, name, slots) for name in search.plugins), return_exceptions=True
            )
            for name, outcome in zip(search.plugins, outcomes):
                if isinstance(outcome, Exception):
                    log.error("search plugin %s crashed the runner", name, exc_info=outcome)
                    search.failed += 1
                    self._add_error(search, name, f"Internal error: {outcome}")
        finally:
            if search.status == "running":
                failed_all = search.failed >= len(search.plugins) and not search.results
                search.status = "error" if failed_all else "finished"
                if not self._closed:
                    self._flush(search)
                    self._emit_status(search)

    async def _run_plugin(self, search: _Search, name: str, slots: asyncio.Semaphore) -> None:
        assert self._process_slots is not None
        async with slots, self._process_slots:
            if search.status != "running" or self._closed:
                return
            parsed = 0

            def on_line(raw: bytes) -> None:
                nonlocal parsed
                result = _parse_result_line(raw, name)
                if result is not None:
                    parsed += 1
                    self._add_result(search, result)

            args = ["search", str(self._engines_dir), name, search.category, search.query]
            try:
                child = await self._spawn(args, self._engines_dir)
            except OSError as exc:
                search.failed += 1
                self._add_error(search, name, f"Could not start the plugin: {exc}")
                return
            search.procs.add(child)
            try:
                code = await self._communicate(child, self.plugin_timeout, on_line)
            finally:
                search.procs.discard(child)

        if search.status != "running":
            return  # stopped or removed: the kill is not the plugin's fault
        stderr = child.stderr_text()
        if stderr.strip():
            log.debug("search plugin %s stderr:\n%s", name, stderr)
        if code is None:
            search.failed += 1
            self._add_error(search, name, f"Timed out after {self.plugin_timeout:g} seconds")
        elif code != 0:
            search.failed += 1
            self._add_error(search, name, _summarize_stderr(stderr) or f"The plugin exited with code {code}")
        elif parsed == 0 and stderr.strip():
            self._add_error(search, name, _summarize_stderr(stderr))

    def _add_result(self, search: _Search, result: dict[str, Any]) -> None:
        if search.status != "running" or result["link"] in search.links:
            return
        if len(search.results) >= MAX_RESULTS_PER_SEARCH:
            return
        search.links.add(result["link"])
        search.results.append(result)
        search.pending.append(result)
        if search.flush_handle is None and self._loop is not None:
            delay = max(0.0, search.last_flush + FLUSH_INTERVAL - self._loop.time())
            search.flush_handle = self._loop.call_later(delay, self._flush, search)

    def _add_error(self, search: _Search, plugin: str, message: str) -> None:
        search.errors.append({"plugin": plugin, "message": message})

    def _flush(self, search: _Search) -> None:
        if search.flush_handle is not None:
            search.flush_handle.cancel()
            search.flush_handle = None
        if not search.pending:
            return
        batch, search.pending = search.pending, []
        if self._loop is not None:
            search.last_flush = self._loop.time()
        if self._searches.get(search.id) is search and not self._closed:
            self._emit("search.results", {"id": search.id, "results": batch, "total": len(search.results)})

    def _emit_status(self, search: _Search) -> None:
        self._emit(
            "search.status",
            {"id": search.id, "status": search.status, "total": len(search.results), "errors": list(search.errors)},
        )

    def _prune_searches(self) -> None:
        excess = len(self._searches) - MAX_KEPT_SEARCHES
        for search_id in [sid for sid, s in self._searches.items() if s.status != "running"][: max(excess, 0)]:
            self.remove_search(search_id)

    def _emit(self, event: str, payload: dict) -> None:
        try:
            self._emit_cb(event, payload)
        except Exception:  # noqa: BLE001 - a broken listener must not break searches
            log.exception("search event listener failed for %s", event)

    def _track(self, task: asyncio.Task[Any]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------------ processes

    def _child_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            PYTHONIOENCODING="utf-8",
            PYTHONUTF8="1",
            PYTHONDONTWRITEBYTECODE="1",
            PYTHONUNBUFFERED="1",
            PROMETHEA_SEARCH_TMP=str(self._tmp_dir),
        )
        return env

    async def _spawn(self, args: list[str], cwd: Path) -> _Child:
        if self._python is None:
            raise OSError("no Python interpreter available")
        if getattr(sys, "frozen", False) and self._python == sys.executable:
            command = [self._python, "--search-runner", *args]  # packaging/launch.py
        else:
            command = [self._python, "-I", "-X", "utf8", str(_RUNNER), *args]
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "env": self._child_env(),
            "cwd": str(cwd),
        }
        if _IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        child: _Child | None = None
        if not self._thread_backend:
            try:
                proc = await asyncio.create_subprocess_exec(*command, limit=LINE_LIMIT, **kwargs)
                child = _AsyncChild(proc)
            except NotImplementedError:
                log.info("event loop lacks subprocess support; running search plugins via threads")
                self._thread_backend = True
        if child is None:
            loop = asyncio.get_running_loop()
            popen = await loop.run_in_executor(None, functools.partial(subprocess.Popen, command, **kwargs))
            child = _ThreadChild(popen, loop)
        self._procs.add(child)
        return child

    async def _communicate(self, child: _Child, timeout: float, on_line: Callable[[bytes], Any]) -> int | None:
        """Feed stdout lines to ``on_line`` until exit. Returns the exit code, None on timeout."""
        try:
            async with asyncio.timeout(timeout):
                while line := await child.readline():
                    try:
                        on_line(line)
                    except Exception:  # noqa: BLE001
                        log.exception("failed to handle plugin output")
                return await child.wait()
        except TimeoutError:
            child.kill()
            await _reap(child, 5)
            return None
        except asyncio.CancelledError:
            child.kill()
            raise
        finally:
            if child.returncode is not None:
                self._procs.discard(child)

    async def _query_info(self, engines_dir: Path, name: str) -> dict[str, Any]:
        """Load a plugin in a subprocess and return its normalised info (ValueError if broken)."""
        lines: list[bytes] = []
        try:
            child = await self._spawn(["info", str(engines_dir), name], engines_dir)
        except OSError as exc:
            raise ValueError(f"could not start Python ({error_text(exc)})") from None
        code = await self._communicate(child, self.info_timeout, lambda line: len(lines) < 1000 and lines.append(line))
        if code is None:
            raise ValueError(f"the plugin did not load within {self.info_timeout:g} seconds")
        if code != 0:
            raise ValueError(_summarize_stderr(child.stderr_text()) or f"the plugin failed to load (exit code {code})")
        for raw in reversed(lines):
            text = raw.decode("utf-8", "replace").strip()
            if text.startswith("{"):
                try:
                    return _normalize_info(json.loads(text), name)
                except ValueError:
                    continue
        raise ValueError("the plugin did not report its capabilities")

    async def _refresh_info(self, plugin: _Plugin) -> None:
        assert self._info_slots is not None
        async with self._info_slots:
            try:
                plugin.info = await self._query_info(self._engines_dir, plugin.name)
                plugin.error = None
                plugin.version = plugin.info["version"]
            except ValueError as exc:
                log.warning("search plugin %s failed to load: %s", plugin.name, exc)
                plugin.info = None
                plugin.error = str(exc)
                plugin.version = read_plugin_version(plugin.path)

    # ------------------------------------------------------------------ install internals

    async def _install_source(self, name: str, content: bytes) -> None:
        """Validate ``content`` in a staging directory, then move it into place atomically."""
        _check_source(content)
        async with self._install_lock:
            try:
                staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=self._data_dir))
            except OSError as exc:
                raise ValueError(f"Could not install {name}.py: {error_text(exc)}") from None
            try:
                staged = staging / f"{name}.py"
                try:
                    staged.write_bytes(content)
                except OSError as exc:
                    raise ValueError(f"Could not install {name}.py: {error_text(exc)}") from None
                try:
                    info = await self._query_info(staging, name)
                except ValueError as exc:
                    raise ValueError(f"{name}.py is not a working search plugin: {exc}") from None

                previous = self._plugins.get(name)
                for other in [n for n in self._plugins if n != name and n.lower() == name.lower()]:
                    # Same file on case-insensitive filesystems: replace, keeping its settings.
                    previous = previous or self._plugins[other]
                    del self._plugins[other]
                    self._delete_plugin_files(other)
                destination = self._engines_dir / f"{name}.py"
                try:
                    _retry_on_lock(os.replace, staged, destination)
                    stat = destination.stat()
                except OSError as exc:
                    raise ValueError(f"Could not install {name}.py: {error_text(exc)}") from None
                self._purge_bytecode(name)
                self._plugins[name] = _Plugin(
                    name=name,
                    path=destination,
                    enabled=previous.enabled if previous else True,
                    info=info,
                    version=info["version"],
                    mtime_ns=stat.st_mtime_ns,
                    size=stat.st_size,
                    icon=self._load_icon(name),
                )
                self._save_state()
            finally:
                shutil.rmtree(staging, ignore_errors=True)

    async def _fetch_icon(self, name: str, urls: Iterable[str]) -> None:
        """Best effort: download an icon for an installed plugin."""
        for url in urls:
            try:
                data, _, _ = await self._http_get(url, MAX_ICON_BYTES, timeout=15, what="icon")
            except ValueError:
                continue
            mime = _icon_mime(data)
            if mime not in ("image/png", "image/x-icon"):
                continue
            extension = ".png" if mime == "image/png" else ".ico"
            try:
                for other in (".png", ".ico"):
                    if other != extension:
                        _unlink(self._engines_dir / f"{name}{other}")
                atomic_write_bytes(self._engines_dir / f"{name}{extension}", data)
            except OSError as exc:
                log.warning("could not save icon for %s: %s", name, exc)
                return
            if name in self._plugins:
                self._plugins[name].icon = self._load_icon(name)
            return

    def _delete_plugin_files(self, name: str) -> None:
        def matches(filename: str) -> bool:
            if _IS_WINDOWS:
                filename, target = filename.lower(), name.lower()
            else:
                target = name
            return filename.startswith(target + ".")

        try:
            entries = list(os.scandir(self._engines_dir))
        except OSError:
            entries = []
        for entry in entries:
            if entry.is_file() and matches(entry.name):
                try:
                    _unlink(Path(entry.path))
                except OSError as exc:
                    log.warning("could not delete %s: %s", entry.path, exc)
        self._purge_bytecode(name)

    def _purge_bytecode(self, name: str) -> None:
        cache = self._engines_dir / "__pycache__"
        if cache.is_dir():
            for pyc in cache.glob(f"{name}.*.pyc"):
                with contextlib.suppress(OSError):
                    pyc.unlink()

    # ------------------------------------------------------------------ storage

    def _scan_engines(self) -> dict[str, Path]:
        found: dict[str, Path] = {}
        try:
            entries = list(os.scandir(self._engines_dir))
        except OSError:
            return found
        for entry in entries:
            if entry.name.endswith(".py") and entry.is_file():
                name = entry.name[:-3]
                if _valid_name(name):
                    found[name] = Path(entry.path)
        return found

    def _load_icon(self, name: str) -> str | None:
        for extension in (".png", ".ico"):
            path = self._engines_dir / f"{name}{extension}"
            try:
                if not path.is_file() or path.stat().st_size > MAX_ICON_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            mime = _icon_mime(data) or ("image/png" if extension == ".png" else "image/x-icon")
            return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        return None

    def _plugin_dict(self, plugin: _Plugin) -> dict:
        info = plugin.info or {}
        return {
            "name": plugin.name,
            "fullName": info.get("name") or plugin.name,
            "version": plugin.version,
            "url": info.get("url", ""),
            "categories": list(info.get("categories", [])),
            "enabled": plugin.enabled,
            "icon": plugin.icon,
            "error": plugin.error,
        }

    def _save_state(self) -> None:
        state: dict[str, Any] = {}
        for plugin in self._plugins.values():
            entry: dict[str, Any] = {"enabled": plugin.enabled}
            if plugin.info is not None:
                entry["cache"] = {"mtime_ns": plugin.mtime_ns, "size": plugin.size, "info": plugin.info}
            state[plugin.name] = entry
        try:
            atomic_write_json(self._state_path, state)
        except OSError as exc:
            log.error("could not save %s: %s", self._state_path, exc)

    def _clean_leftovers(self) -> None:
        with contextlib.suppress(OSError):
            for entry in os.scandir(self._data_dir):
                if entry.name.startswith(".staging-") and entry.is_dir():
                    shutil.rmtree(entry.path, ignore_errors=True)
        cutoff = time.time() - TMP_MAX_AGE
        with contextlib.suppress(OSError):
            for entry in os.scandir(self._tmp_dir):
                with contextlib.suppress(OSError):
                    if entry.is_file() and entry.stat().st_mtime < cutoff:
                        os.unlink(entry.path)

    # ------------------------------------------------------------------ HTTP

    async def _http_get(self, url: str, max_bytes: int, timeout: float, what: str) -> tuple[bytes, str, str | None]:
        """GET ``url``; returns (body, final url, Content-Disposition filename). ValueError on failure."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": "Promethea (search plugins)"}, trust_env=True)
        try:
            async with self._session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
                if response.status != 200:
                    raise ValueError(f"Could not download the {what}: HTTP {response.status} {response.reason or ''}".rstrip())
                if response.content_length is not None and response.content_length > max_bytes:
                    raise ValueError(f"The {what} is too large (over {max_bytes // 1024} KB)")
                body = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    body += chunk
                    if len(body) > max_bytes:
                        raise ValueError(f"The {what} is too large (over {max_bytes // 1024} KB)")
                filename = None
                with contextlib.suppress(Exception):
                    disposition = response.content_disposition
                    filename = disposition.filename if disposition else None
                return bytes(body), str(response.url), filename
        except TimeoutError:
            raise ValueError(f"Timed out downloading the {what} from {url}") from None
        except aiohttp.InvalidURL:
            raise ValueError(f"Invalid URL: {url}") from None
        except aiohttp.ClientError as exc:
            raise ValueError(f"Could not download the {what}: {exc}") from None
