"""Process entry point: wires the engine, search, RSS and the API server together and
runs them either headless or behind the desktop window."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import logging.handlers
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import IO, Any, Callable

import aiohttp

from . import APP_NAME, __version__
from .engine import AddOptions, DuplicateTorrent, Engine, SourceError
from .paths import data_dir
from .prefs import Prefs
from .rss import RssManager
from .search import SearchManager
from .server import Desktop, Hub, Server
from .util import atomic_write_json, error_text, read_json

log = logging.getLogger("promethea.app")


class Core:
    """Everything except the GUI. All methods run on one asyncio loop."""

    def __init__(self, home: Path, desktop: Desktop | None = None,
                 on_quit: Callable[[], None] | None = None) -> None:
        self.home = home
        self.prefs = Prefs(home / "prefs.json")
        self.hub = Hub()
        self.engine = Engine(home, self.prefs, self.hub.emit)
        self.search = SearchManager(home / "search", self.hub.emit)
        self.rss = RssManager(home / "rss", self.hub.emit, self._add_from_rss, lambda: {"rss": self.prefs["rss"]})
        self.server = Server(engine=self.engine, prefs=self.prefs, hub=self.hub, data_dir=home,
                             rss=self.rss, search=self.search, desktop=desktop, on_quit=on_quit)

    async def _add_from_rss(self, url: str, params: dict[str, Any]) -> None:
        # Named by its title: tracker links carry passkeys, which don't belong in the log.
        what = f"“{params.get('article') or 'an article'}” (rule “{params.get('rule') or ''}”)"
        try:
            await self.engine.add_text(url, AddOptions.from_dict(params))
        except DuplicateTorrent as e:
            log.info("RSS: %s: %s", what, e)  # its trackers were merged in, as qBittorrent does
        except (SourceError, aiohttp.ClientError, OSError) as e:
            self.engine._log("warning", f"RSS: couldn't download {what}: {error_text(e)}")

    async def start(self, port: int = 0, *, fallback: bool = False) -> int:
        await self.engine.open()
        await self.search.start()
        await self.rss.start()
        port = await self.server.start_local(port, fallback=fallback)
        await self.server.apply_webui()
        return port

    async def close(self) -> None:
        for name, step in (("server", self.server.close), ("rss", self.rss.close),
                           ("search", self.search.close), ("engine", self.engine.close)):
            try:
                await step()
            except Exception:  # noqa: BLE001
                log.exception("shutting down %s failed", name)


class Instance:
    """Single-instance guard: a lock file, plus instance.json with the local API port and token
    so a second launch (double-clicked .torrent, magnet link) can hand its sources over."""

    def __init__(self, home: Path) -> None:
        self.lock_path = home / "instance.lock"
        self.info_path = home / "instance.json"
        self._fh: IO[bytes] | None = None

    def acquire(self) -> bool:
        fh = open(self.lock_path, "a+b")  # noqa: SIM115 - held for the process lifetime
        try:
            if sys.platform == "win32":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True

    def publish(self, port: int, token: str) -> None:
        atomic_write_json(self.info_path, {"pid": os.getpid(), "port": port, "token": token})

    def release(self) -> None:
        with contextlib.suppress(OSError):
            self.info_path.unlink()
        if self._fh is not None:
            with contextlib.suppress(OSError):
                if sys.platform == "win32":
                    import msvcrt

                    self._fh.seek(0)
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                self._fh.close()
            self._fh = None

    def forward(self, sources: list[str], timeout: float = 30.0) -> bool | None:
        """Give `sources` to the running instance (and bring its window up). True when it took
        them, False when it never answered, None when it quit meanwhile and this process now
        holds the profile."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            info = read_json(self.info_path, None)
            if not isinstance(info, dict) or not info.get("port") or not info.get("token"):
                # Still starting, or quitting (it removes the file first).
                if self.acquire():
                    return None
            else:
                _allow_foreground(info.get("pid"))
                req = urllib.request.Request(
                    f"http://127.0.0.1:{int(info['port'])}/api/app/open",
                    data=json.dumps({"sources": sources}).encode(),
                    method="POST",
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {info['token']}"},
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 - fixed loopback URL
                        return r.status == 200
                except (OSError, urllib.error.URLError):
                    pass
            time.sleep(0.25)
        return False


def _allow_foreground(pid: Any) -> None:
    """Let the running instance bring its window to the front: Windows only lets the process
    the user is interacting with do that, and this one can pass the right on."""
    if sys.platform == "win32" and isinstance(pid, int):
        with contextlib.suppress(Exception):
            import ctypes

            ctypes.windll.user32.AllowSetForegroundWindow(pid)


def setup_logging(home: Path, *, console: bool) -> None:
    logs = home / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(logs / "promethea.log", maxBytes=2 * 1024 * 1024, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    if console:
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        root.addHandler(sh)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


async def run_headless(home: Path, port: int, sources: list[str], instance: Instance) -> None:
    stop = asyncio.Event()
    core = Core(home, on_quit=stop.set)
    port = await core.start(port)
    instance.publish(port, core.server.token)
    print(f"{APP_NAME} {__version__} is running. Open {core.server.local_url()}", flush=True)
    if sources:
        await core.server.open_sources(sources)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
            loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await core.close()


def _complain(text: str) -> None:
    """Tell whoever launched Promethea: on the console, or in a message box when there's none
    (pythonw.exe, opening a .torrent file)."""
    if sys.stderr is not None:
        print(text, file=sys.stderr)
    elif sys.platform == "win32":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10)  # MB_ICONERROR


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="promethea", description=f"{APP_NAME}: a fast BitTorrent client.")
    p.add_argument("sources", nargs="*", help=".torrent files, magnet links or info hashes to add")
    p.add_argument("--headless", action="store_true", help="run without a window (use the Web UI)")
    p.add_argument("--port", type=int, default=0, help="port of the local API (default: the desktop app's last one; headless, random)")
    p.add_argument("--minimized", action="store_true", help="start hidden in the tray")
    p.add_argument("--data-dir", help="settings and state directory (default: per-user app data)")
    p.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.data_dir:
        os.environ["PROMETHEA_HOME"] = str(Path(args.data_dir).resolve())
    home = data_dir()
    sources = [os.path.abspath(s) if os.path.isfile(s) else s for s in args.sources]

    instance = Instance(home)
    if not instance.acquire():
        # Another Promethea owns this profile: hand over what we were asked to open, then leave.
        handed = instance.forward(sources)
        if handed:
            return 0
        if handed is False:
            _complain(f"{APP_NAME} is already running but isn't responding.")
            return 1
        # It quit while this one started: carry on in its place.

    setup_logging(home, console=args.headless)
    log.info("%s %s starting (data: %s)", APP_NAME, __version__, home)
    try:
        if args.headless:
            with contextlib.suppress(KeyboardInterrupt):
                asyncio.run(run_headless(home, args.port, sources, instance))
        else:
            from .desktop import run_desktop

            run_desktop(home, args, sources, instance)
    finally:
        instance.release()
        log.info("%s stopped", APP_NAME)
    return 0
