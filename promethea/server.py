"""HTTP + WebSocket API.

One route table is served twice:

* a local listener on 127.0.0.1 (random port) for the desktop window, guarded
  by a random token and Host-header checks;
* optionally, the remote Web UI on a user-chosen address, guarded by
  username/password sessions.

State reaches the UI over a WebSocket: one full snapshot on connect, then one
small delta per refresh tick, plus named events.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import ssl
import string
import sys
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any, Callable, Protocol

from aiohttp import WSMsgType, web

from . import __version__
from . import platform as plat
from .engine import AddOptions, DuplicateTorrent, Engine, NotFound, SourceError
from .engine import details
from .engine.sources import is_info_hash, is_magnet, torrent_file_bytes
from .paths import web_dir
from .prefs import Prefs, verify_password
from .util import error_text
from .search import NotFoundError as SearchNotFound

log = logging.getLogger("promethea.server")

MAX_UPLOAD = 64 * 1024 * 1024
LOCAL_COOKIE = "promethea_local"
REMOTE_COOKIE = "promethea_sid"
_RESYNC = object()


def dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def ok(data: Any = None) -> web.Response:
    return web.json_response({"ok": True} if data is None else data, dumps=dumps)


_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def _file_stem(name: str, fallback: str) -> str:
    """A torrent name made safe to use as a file name on every platform."""
    stem = "".join(c for c in name if c not in '<>:"/\\|?*' and ord(c) >= 32).strip().rstrip(". ")[:180]
    if not stem or stem.split(".")[0].strip().upper() in _RESERVED_NAMES:
        return fallback
    return stem


class Desktop(Protocol):
    """What the desktop shell offers the server (None when headless)."""

    def dialog(self, kind: str, title: str, directory: str, multiple: bool,
               file_types: list[str], save_name: str) -> list[str]: ...
    def show(self) -> None: ...
    def quit(self) -> None: ...


# --------------------------------------------------------------- fan-out hub
class Client:
    def __init__(self, ws: web.WebSocketResponse, local: bool, full: Callable[[], dict]) -> None:
        self.ws = ws
        self.local = local
        self._full = full
        self.queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=512)
        self.overflow = False

    def push(self, text: str) -> None:
        if self.overflow:
            return
        try:
            self.queue.put_nowait(text)
        except asyncio.QueueFull:
            # The client can't keep up: drop the backlog and resend a full snapshot.
            self.overflow = True
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait(_RESYNC)

    async def run(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                if item is _RESYNC:
                    self.overflow = False
                    item = dumps(self._full())
                await self.ws.send_str(item)
        except (ConnectionError, RuntimeError):
            # The socket went away mid-send; the receive loop notices and cleans up.
            await self.ws.close()


class Hub:
    """Sends sync deltas and events to every connected UI."""

    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.taps: list[Callable[[str, dict], None]] = []
        self.pending_local: list[str] = []

    def emit(self, name: str, data: dict) -> None:
        for tap in self.taps:
            try:
                tap(name, data)
            except Exception:  # noqa: BLE001
                log.exception("event tap failed")
        if self.clients:
            self.send({"t": "event", "name": name, "data": data})

    def emit_local(self, name: str, data: dict) -> None:
        """An event only the desktop window should act on (queued until it connects)."""
        text = dumps({"t": "event", "name": name, "data": data})
        targets = [c for c in self.clients if c.local]
        if not targets:
            self.pending_local.append(text)
            return
        for c in targets:
            c.push(text)

    def send(self, msg: dict) -> None:
        text = dumps(msg)
        for c in list(self.clients):
            c.push(text)


# ------------------------------------------------------------------- server
class Server:
    def __init__(self, *, engine: Engine, prefs: Prefs, hub: Hub, data_dir: Path,
                 rss: Any = None, search: Any = None, desktop: Desktop | None = None,
                 on_quit: Callable[[], None] | None = None) -> None:
        self.engine = engine
        self.prefs = prefs
        self.hub = hub
        self.data_dir = data_dir
        self.rss = rss
        self.search = search
        self.desktop = desktop
        self.on_quit = on_quit  # headless: how /api/app/quit stops the process
        self.token = secrets.token_urlsafe(32)
        self._local_session = secrets.token_urlsafe(32)
        self.local_port = 0
        self._local_runner: web.AppRunner | None = None
        self._remote_runner: web.AppRunner | None = None
        self._remote_sig: tuple | None = None
        self.remote_error = ""
        self.sessions: dict[str, float] = {}
        self.failures: dict[str, dict[str, float]] = {}
        self._web = web_dir()
        engine.add_sync_listener(self._on_sync)

    # ------------------------------------------------------------ lifecycle
    async def start_local(self, port: int = 0, *, fallback: bool = False) -> int:
        """Listen on 127.0.0.1:`port` (0: any free port; with `fallback`, any free port when
        that one is taken)."""
        app = self._make_app(local=True)
        self._local_runner = web.AppRunner(app, access_log=None, handle_signals=False)
        await self._local_runner.setup()
        site = web.TCPSite(self._local_runner, "127.0.0.1", port, reuse_address=False)
        try:
            await site.start()
        except OSError:
            if not (port and fallback):
                raise
            await site.stop()
            log.info("local port %d is taken; using another", port)
            await web.TCPSite(self._local_runner, "127.0.0.1", 0, reuse_address=False).start()
        self.local_port = self._local_runner.addresses[0][1]
        return self.local_port

    def local_url(self) -> str:
        return f"http://127.0.0.1:{self.local_port}/auth?token={self.token}"

    async def apply_webui(self) -> None:
        """Start, restart or stop the remote Web UI to match the preferences."""
        w = self.prefs["webui"]
        sig = (w["enabled"], w["address"], w["port"], w["https"], w["certPath"], w["keyPath"])
        if sig == self._remote_sig:
            return
        self._remote_sig = sig
        if self._remote_runner is not None:
            await self._remote_runner.cleanup()
            self._remote_runner = None
        self.remote_error = ""
        if not w["enabled"]:
            return
        ctx = None
        if w["https"]:
            try:
                ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
                ctx.load_cert_chain(w["certPath"], w["keyPath"])
            except (OSError, ssl.SSLError) as e:
                self.remote_error = f"HTTPS certificate problem: {e}"
                self.engine._log("error", f"Web UI not started: {self.remote_error}")
                return
        host = w["address"].strip()
        hosts = None if host in ("", "*", "0.0.0.0", "::") else host
        app = self._make_app(local=False)
        runner = web.AppRunner(app, access_log=None, handle_signals=False)
        await runner.setup()
        try:
            await web.TCPSite(runner, hosts, w["port"], ssl_context=ctx).start()
        except OSError as e:
            await runner.cleanup()
            self.remote_error = f"could not listen on port {w['port']}: {e.strerror or e}"
            self.engine._log("error", f"Web UI not started: {self.remote_error}")
            return
        self._remote_runner = runner
        scheme = "https" if ctx else "http"
        self.engine._log("info", f"Web UI listening on {scheme}://{host or '*'}:{w['port']}")

    async def close(self) -> None:
        for c in list(self.hub.clients):
            try:
                await c.ws.close()
            except Exception:  # noqa: BLE001
                pass
        for runner in (self._remote_runner, self._local_runner):
            if runner is not None:
                await runner.cleanup()

    # -------------------------------------------------------------- sync
    def _on_sync(self, delta: dict) -> None:
        if self.hub.clients:
            self.hub.send(delta)

    def _full(self) -> dict:
        return self.engine.full_sync()

    # ----------------------------------------------------------- app setup
    def _make_app(self, *, local: bool) -> web.Application:
        app = web.Application(client_max_size=MAX_UPLOAD, middlewares=[self._guard, self._errors])
        app["local"] = local
        app.on_response_prepare.append(self._headers)
        r = app.router
        r.add_get("/auth", self.local_auth)
        r.add_get("/api/auth/state", self.auth_state)
        r.add_post("/api/auth/login", self.login)
        r.add_post("/api/auth/logout", self.logout)
        r.add_get("/api/ws", self.websocket)
        r.add_get("/api/app", self.app_info)
        r.add_post("/api/app/open", self.app_open)
        r.add_post("/api/app/quit", self.app_quit)
        r.add_get("/api/prefs", self.get_prefs)
        r.add_post("/api/prefs", self.set_prefs)
        r.add_get("/api/log", self.get_log)
        r.add_get("/api/log/blocked", self.get_blocked)
        r.add_post("/api/dialog", self.dialog)
        r.add_post("/api/os/open", self.os_open)
        r.add_post("/api/os/url", self.os_url)
        r.add_post("/api/os/associate", self.os_associate)
        r.add_post("/api/os/autostart", self.os_autostart)
        r.add_get("/api/fs/freespace", self.fs_freespace)
        r.add_get("/api/fs/complete", self.fs_complete)
        # torrents
        r.add_get("/api/torrents", self.torrents)
        r.add_post("/api/torrents/inspect", self.inspect)
        r.add_post("/api/torrents/inspect/cancel", self.inspect_cancel)
        r.add_post("/api/torrents/add", self.add)
        r.add_post("/api/torrents/action", self.action)
        r.add_post("/api/torrents/delete", self.delete)
        r.add_post("/api/torrents/set", self.set_props)
        r.add_post("/api/torrents/location", self.location)
        r.add_post("/api/torrents/rename", self.rename)
        r.add_post("/api/torrents/export", self.export_many)
        r.add_get("/api/torrents/{id}/properties", self.t_properties)
        r.add_get("/api/torrents/{id}/files", self.t_files)
        r.add_get("/api/torrents/{id}/peers", self.t_peers)
        r.add_get("/api/torrents/{id}/trackers", self.t_trackers)
        r.add_get("/api/torrents/{id}/webseeds", self.t_webseeds)
        r.add_get("/api/torrents/{id}/pieces", self.t_pieces)
        r.add_get("/api/torrents/{id}/export", self.t_export)
        r.add_post("/api/torrents/{id}/files/priority", self.t_file_priority)
        r.add_post("/api/torrents/{id}/files/rename", self.t_file_rename)
        r.add_post("/api/torrents/{id}/peers/add", self.t_add_peers)
        r.add_post("/api/torrents/{id}/trackers", self.t_edit_trackers)
        r.add_post("/api/torrents/{id}/webseeds", self.t_edit_webseeds)
        r.add_post("/api/peers/ban", self.ban_peers)
        # categories, tags, speed
        r.add_post("/api/categories", self.category_set)
        r.add_post("/api/categories/delete", self.category_delete)
        r.add_post("/api/tags", self.tags_create)
        r.add_post("/api/tags/delete", self.tags_delete)
        r.add_post("/api/transfer/alt", self.transfer_alt)
        r.add_post("/api/transfer/limits", self.transfer_limits)
        # torrent creator
        r.add_get("/api/creator", self.creator_jobs)
        r.add_post("/api/creator", self.creator_start)
        r.add_post("/api/creator/inspect", self.creator_inspect)
        r.add_post("/api/creator/{id}/cancel", self.creator_cancel)
        r.add_post("/api/creator/{id}/reveal", self.creator_reveal)
        # search
        r.add_get("/api/search/plugins", self.s_plugins)
        r.add_post("/api/search/plugins/install", self.s_install)
        r.add_post("/api/search/plugins/uninstall", self.s_uninstall)
        r.add_post("/api/search/plugins/enable", self.s_enable)
        r.add_get("/api/search/plugins/updates", self.s_check_updates)
        r.add_get("/api/search/plugins/official", self.s_official)
        r.add_post("/api/search/plugins/update", self.s_update)
        r.add_get("/api/search", self.s_list)
        r.add_post("/api/search", self.s_start)
        r.add_get("/api/search/{id}", self.s_get)
        r.add_post("/api/search/{id}/stop", self.s_stop)
        r.add_post("/api/search/{id}/remove", self.s_remove)
        r.add_post("/api/search/download", self.s_download)
        # rss
        self._add_rss_routes(r)
        # static UI
        r.add_get("/{tail:.*}", self.static)
        return app

    # ------------------------------------------------------------ middleware
    def _local_hosts(self) -> set[str]:
        p = self.local_port
        return {f"127.0.0.1:{p}", f"localhost:{p}"}

    def _is_local_authed(self, request: web.Request) -> bool:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), self.token):
            return True
        cookie = request.cookies.get(LOCAL_COOKIE, "")
        return bool(cookie) and hmac.compare_digest(cookie, self._local_session)

    def _is_remote_authed(self, request: web.Request) -> bool:
        w = self.prefs["webui"]
        if w["bypassLocalhost"] and request.remote in ("127.0.0.1", "::1"):
            host = request.headers.get("Host", "").rsplit(":", 1)[0].strip("[]").lower()
            if host in ("localhost", "127.0.0.1", "::1"):
                return True
        sid = request.cookies.get(REMOTE_COOKIE, "")
        exp = self.sessions.get(sid)
        now = time.time()
        if not sid or exp is None or exp < now:
            if sid:
                self.sessions.pop(sid, None)
            return False
        self.sessions[sid] = now + max(60, w["sessionTimeout"])
        return True

    def _authed(self, request: web.Request) -> bool:
        return self._is_local_authed(request) if request.app["local"] else self._is_remote_authed(request)

    @web.middleware
    async def _guard(self, request: web.Request, handler: Callable) -> web.StreamResponse:
        local = request.app["local"]
        if local and request.headers.get("Host", "") not in self._local_hosts():
            raise web.HTTPForbidden(text="Unexpected Host header")
        path = request.path
        if path.startswith("/api/"):
            # Browsers always send Origin on cross-site fetches and WebSocket
            # handshakes; a page on another site must never drive the API.
            origin = request.headers.get("Origin")
            if origin and urllib.parse.urlsplit(origin).netloc.lower() != request.headers.get("Host", "").lower():
                raise web.HTTPForbidden(text="Cross-origin request refused")
            if path not in ("/api/auth/state", "/api/auth/login") and not self._authed(request):
                raise web.HTTPUnauthorized(text="Not authenticated")
        return await handler(request)

    @web.middleware
    async def _errors(self, request: web.Request, handler: Callable) -> web.StreamResponse:
        def fail(message: str, status: int, **extra: Any) -> web.Response:
            return web.json_response({"error": message, **extra}, status=status, dumps=dumps)

        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except DuplicateTorrent as e:
            return fail(str(e), 409, id=e.tid)
        except NotFound as e:
            return fail(f"Not found: {e.args[0] if e.args else ''}", 404)
        except SearchNotFound as e:
            return fail(str(e), 404)
        except KeyError as e:
            return fail(f"Missing value: {e.args[0] if e.args else e}", 400)
        except PermissionError as e:
            return fail(error_text(e), 403)
        except FileExistsError as e:
            return fail(error_text(e), 409, exists=True)
        except json.JSONDecodeError:
            return fail("Request body is not valid JSON", 400)
        except (SourceError, ValueError, TypeError) as e:
            if isinstance(e, TypeError):
                log.warning("bad request to %s: %s", request.path, e)
            return fail(str(e) or type(e).__name__, 400)
        except Exception as e:  # noqa: BLE001
            log.exception("error handling %s", request.path)
            return fail(f"Internal error: {error_text(e)}", 500)

    async def _headers(self, request: web.Request, response: web.StreamResponse) -> None:
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("X-Frame-Options", "DENY")
        if request.path.startswith("/assets/"):
            h["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not isinstance(response, web.WebSocketResponse):
            h.setdefault("Cache-Control", "no-store")
            # Remote images: the pictures in RSS articles (qBittorrent shows them too).
            h.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; "
                "connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            )

    # ------------------------------------------------------------- helpers
    @staticmethod
    async def _body(request: web.Request) -> dict[str, Any]:
        if not request.can_read_body:
            return {}
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    def _ids(self, body: dict[str, Any]) -> list[str]:
        ids = body.get("ids")
        if ids == "all":
            return list(self.engine.entries)
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
            raise ValueError("ids must be a list of torrent ids")
        return ids

    def _entry(self, request: web.Request):
        return self.engine.get(request.match_info["id"])

    def _require_desktop(self, request: web.Request) -> Desktop:
        if not request.app["local"] or self.desktop is None:
            raise PermissionError("only available in the desktop app")
        return self.desktop

    def _require_local(self, request: web.Request) -> None:
        if not request.app["local"]:
            raise PermissionError("only available in the desktop app")

    @staticmethod
    def _check_source(request: web.Request, text: str) -> None:
        """Remote users may add links, but not read files off this computer."""
        if request.app["local"]:
            return
        t = text.strip()
        if not (is_magnet(t) or is_info_hash(t) or t.lower().startswith(("http://", "https://"))):
            raise SourceError("enter a magnet link, info hash or http(s) URL")

    @staticmethod
    async def _run(fn: Callable, *args: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    # --------------------------------------------------------- auth & app
    async def local_auth(self, request: web.Request) -> web.StreamResponse:
        if not request.app["local"]:
            raise web.HTTPNotFound()
        token = request.query.get("token", "")
        if not token or not hmac.compare_digest(token, self.token):
            raise web.HTTPForbidden(text="Invalid token")
        resp = web.HTTPFound("/")
        resp.set_cookie(LOCAL_COOKIE, self._local_session, httponly=True, samesite="Strict", path="/")
        raise resp

    async def auth_state(self, request: web.Request) -> web.Response:
        local = request.app["local"]
        w = self.prefs["webui"]
        return ok({
            "authenticated": self._authed(request),
            "local": local,
            "desktop": local and self.desktop is not None,
            "passwordSet": bool(w["passwordHash"]),
            "version": __version__,
        })

    async def login(self, request: web.Request) -> web.Response:
        if request.app["local"]:
            return ok()
        ip = request.remote or "?"
        now = time.time()
        rec = self.failures.get(ip)
        if rec and rec.get("until", 0) > now:
            raise PermissionError("Too many failed login attempts. Try again later.")
        body = await self._body(request)
        w = self.prefs["webui"]
        if not w["passwordHash"]:
            raise PermissionError("Set a Web UI password in the desktop app first.")
        user = str(body.get("username", ""))
        password = str(body.get("password", ""))
        good = hmac.compare_digest(user.encode(), w["username"].encode())
        good = await self._run(verify_password, password, w["passwordHash"]) and good
        if not good:
            rec = self.failures.setdefault(ip, {"count": 0, "until": 0})
            rec["count"] += 1
            if rec["count"] >= max(1, w["maxAuthFailures"]):
                rec["count"] = 0
                rec["until"] = now + max(0, w["banDuration"])
                self.engine._log("warning", f"Web UI: {ip} banned after repeated failed logins")
            await asyncio.sleep(1)
            return web.json_response({"error": "Wrong username or password"}, status=401)
        self.failures.pop(ip, None)
        for old, exp in list(self.sessions.items()):
            if exp < now:
                del self.sessions[old]
        sid = secrets.token_urlsafe(32)
        self.sessions[sid] = now + max(60, w["sessionTimeout"])
        resp = ok()
        resp.set_cookie(REMOTE_COOKIE, sid, httponly=True, samesite="Strict", path="/", secure=request.secure)
        return resp

    async def logout(self, request: web.Request) -> web.Response:
        self.sessions.pop(request.cookies.get(REMOTE_COOKIE, ""), None)
        resp = ok()
        resp.del_cookie(REMOTE_COOKIE, path="/")
        return resp

    async def app_info(self, request: web.Request) -> web.Response:
        local = request.app["local"]
        import libtorrent as lt

        info: dict[str, Any] = {
            "version": __version__,
            "libtorrent": lt.__version__,
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "local": local,
            "desktop": local and self.desktop is not None,
            "canQuit": self._quitter(local) is not None,
            "webuiError": self.remote_error,
        }
        if local:
            info["dataDir"] = str(self.data_dir)
            info["fileAssociation"] = plat.is_associated()
            info["autostart"] = plat.autostart_enabled()
        return ok(info)

    async def app_open(self, request: web.Request) -> web.Response:
        """Sources handed over by a second launch (file association, magnet link)."""
        self._require_local(request)
        body = await self._body(request)
        sources = [s for s in body.get("sources", []) if isinstance(s, str) and s.strip()]
        if self.desktop is not None:
            self.desktop.show()
        await self.open_sources(sources)
        return ok()

    async def open_sources(self, sources: list[str]) -> None:
        """Add sources from the command line: via the add dialog, or directly."""
        for src in sources:
            try:
                if self.prefs["downloads"]["showAddDialog"] and self.desktop is not None:
                    info = await self.engine.inspect(text=src)
                    self.hub.emit_local("addDialog", info)
                else:
                    await self.engine.add_text(src, AddOptions())
            except DuplicateTorrent as e:
                self.hub.emit("toast", {"kind": "info", "message": str(e)})
            except (SourceError, OSError) as e:
                self.hub.emit("toast", {"kind": "error", "message": f"Could not add {src}: {error_text(e)}"})

    def _quitter(self, local: bool) -> Callable[[], None] | None:
        if self.desktop is not None:
            return self.desktop.quit if local else None
        return self.on_quit

    async def app_quit(self, request: web.Request) -> web.Response:
        quit_ = self._quitter(request.app["local"])
        if quit_ is None:
            raise PermissionError("Quitting is only available from the desktop app")
        asyncio.get_running_loop().call_later(0.1, quit_)
        return ok()

    # ---------------------------------------------------------------- prefs
    async def get_prefs(self, request: web.Request) -> web.Response:
        return ok(self.prefs.public())

    async def set_prefs(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        changed = self.prefs.update(body, local=request.app["local"])
        if changed:
            self.engine.apply_prefs(changed)
            sections = {s for s, _ in changed}
            if "rss" in sections and self.rss is not None and hasattr(self.rss, "apply_prefs"):
                await _maybe_await(self.rss.apply_prefs())
            if changed & {("webui", "passwordHash"), ("webui", "username")}:
                self.sessions.clear()  # new credentials sign everyone out
            if "webui" in sections:
                await self.apply_webui()
            self.hub.emit("prefs", self.prefs.public())
        return ok(self.prefs.public())

    async def get_log(self, request: web.Request) -> web.Response:
        after = int(request.query.get("after", "0") or 0)
        return ok(self.engine.log_since(after))

    async def get_blocked(self, request: web.Request) -> web.Response:
        return ok(list(self.engine.blocked))

    # --------------------------------------------------------- desktop & os
    async def dialog(self, request: web.Request) -> web.Response:
        desktop = self._require_desktop(request)
        body = await self._body(request)
        kind = body.get("kind", "open")
        if kind not in ("open", "folder", "save"):
            raise ValueError("kind must be open, folder or save")
        paths = await self._run(
            desktop.dialog, kind, str(body.get("title", "")), str(body.get("directory", "")),
            bool(body.get("multiple", False)), list(body.get("fileTypes", [])), str(body.get("saveName", "")),
        )
        return ok({"paths": paths or []})

    def _content_path(self, tid: str, rel: str | None) -> str:
        e = self.engine.get(tid)
        st = e.handle.status(details.Q_SAVE_PATH)
        base = os.path.abspath(st.save_path)
        if rel:
            target = os.path.abspath(os.path.join(base, *rel.split("/")))
            if os.path.commonpath([base, target]) != base:
                raise ValueError("path is outside the torrent's folder")
            # The UI names unfinished files without their incomplete-file extension.
            if not os.path.exists(target) and os.path.exists(target + details.INCOMPLETE_EXT):
                return target + details.INCOMPLETE_EXT
            return target
        files = [p for _, p in details.real_files(e)]
        if not files:
            return base
        if len(files) == 1:
            return os.path.join(base, *files[0].split("/"))
        roots = {p.split("/", 1)[0] for p in files}
        if len(roots) == 1 and all("/" in p for p in files):
            return os.path.join(base, roots.pop())
        return base

    async def os_open(self, request: web.Request) -> web.Response:
        self._require_desktop(request)
        body = await self._body(request)
        target = self._content_path(str(body["id"]), body.get("path"))
        reveal = bool(body.get("reveal"))
        if not reveal and not os.path.exists(target):
            raise ValueError("the file does not exist yet")
        await self._run(plat.reveal_path if reveal else plat.open_path, target)
        return ok()

    async def os_url(self, request: web.Request) -> web.Response:
        """Open a web page in the default browser: the desktop window doesn't open new windows."""
        self._require_desktop(request)
        body = await self._body(request)
        url = str(body.get("url", "")).strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("only web links can be opened")
        await self._run(webbrowser.open, url)
        return ok()

    async def os_associate(self, request: web.Request) -> web.Response:
        self._require_desktop(request)
        await self._run(plat.associate_files)
        return ok({"fileAssociation": plat.is_associated()})

    async def os_autostart(self, request: web.Request) -> web.Response:
        self._require_desktop(request)
        body = await self._body(request)
        await self._run(plat.set_autostart, bool(body.get("enabled")))
        return ok({"autostart": plat.autostart_enabled()})

    async def fs_freespace(self, request: web.Request) -> web.Response:
        path = request.query.get("path", "") or self.prefs["downloads"]["savePath"]
        return ok({"path": path, "free": await self._run(plat.free_space, path)})

    async def fs_complete(self, request: web.Request) -> web.Response:
        return ok({"dirs": await self._run(_complete_dirs, request.query.get("path", ""))})

    # -------------------------------------------------------------- torrents
    async def torrents(self, request: web.Request) -> web.Response:
        return ok(self.engine.full_sync()["torrents"])

    async def inspect(self, request: web.Request) -> web.Response:
        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            data = None
            async for part in reader:
                if part.name in ("file", "torrent"):
                    data = bytes(await part.read(decode=False))
            if data is None:
                raise ValueError("no torrent file uploaded")
            return ok(await self.engine.inspect(data=data))
        body = await self._body(request)
        text = str(body.get("text", ""))
        self._check_source(request, text)
        return ok(await self.engine.inspect(text=text))

    async def inspect_cancel(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.cancel_pending(str(body.get("token", "")))
        return ok()

    async def add(self, request: web.Request) -> web.Response:
        """Add torrents: multipart (files + options), or JSON {sources|token, options}."""
        added: list[str] = []
        errors: list[dict[str, str]] = []
        duplicates: list[dict[str, str]] = []

        async def attempt(label: str, add: Callable[[], Any]) -> None:
            try:
                added.append(await add())
            except DuplicateTorrent as e:
                duplicates.append({"source": label, "id": e.tid, "error": str(e),
                                   "trackers": e.trackers, "webSeeds": e.web_seeds})
            except (SourceError, OSError) as e:
                errors.append({"source": label, "error": error_text(e)})

        def text_source(text: str) -> Callable[[], Any]:
            async def add() -> str:
                self._check_source(request, text)
                return await self.engine.add_text(text, options)
            return add

        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            files: list[tuple[str, bytes]] = []
            urls: list[str] = []
            opts: dict[str, Any] = {}
            async for part in reader:
                if part.name == "options":
                    opts = json.loads(await part.text() or "{}")
                elif part.name in ("file", "files", "torrent", "torrents"):
                    files.append((part.filename or "torrent", bytes(await part.read(decode=False))))
                elif part.name == "urls":
                    urls += [u.strip() for u in (await part.text()).splitlines() if u.strip()]
            options = AddOptions.from_dict(opts)
            for name, data in files:
                await attempt(name, lambda data=data: self.engine.add_bytes(data, options))
            for url in urls:
                await attempt(url, text_source(url))
        else:
            body = await self._body(request)
            options = AddOptions.from_dict(body.get("options"))
            if body.get("token"):
                token = str(body["token"])
                await attempt("torrent", lambda: self.engine.add_pending(token, options))
            for src in body.get("sources", []) or []:
                if isinstance(src, str) and src.strip():
                    await attempt(src.strip(), text_source(src.strip()))
        return ok({"added": added, "errors": errors, "duplicates": duplicates})

    async def action(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        act = body.get("action")
        eng = self.engine
        if act == "startAll":
            eng.start_all()
            return ok()
        if act == "stopAll":
            eng.stop_all()
            return ok()
        ids = self._ids(body)
        value = body.get("value")
        simple = {
            "start": eng.start, "forceStart": eng.force_start, "stop": eng.stop,
            "recheck": eng.recheck, "reannounce": eng.reannounce,
        }
        if act in simple:
            simple[act](ids)
        elif act in ("queueTop", "queueUp", "queueDown", "queueBottom"):
            eng.queue(ids, act[5:].lower())
        elif act in ("sequential", "firstLast", "superSeeding"):
            eng.set_flag(ids, act, bool(value))
        elif act == "autoTMM":
            eng.set_auto_tmm(ids, bool(value))
        else:
            raise ValueError(f"unknown action {act!r}")
        return ok()

    async def delete(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        await self.engine.remove(self._ids(body), bool(body.get("deleteFiles")))
        return ok()

    async def set_props(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        ids = self._ids(body)
        eng = self.engine
        if "category" in body:
            eng.set_category(ids, str(body["category"] or ""))
        if "tags" in body:
            t = body["tags"]
            eng.set_tags(ids, [str(x) for x in t.get("tags", [])], str(t.get("mode", "add")))
        if "dlLimit" in body or "upLimit" in body:
            dl = body.get("dlLimit")
            ul = body.get("upLimit")
            eng.set_limits(ids, None if dl is None else int(dl), None if ul is None else int(ul))
        if "shareLimits" in body:
            s = body["shareLimits"]
            eng.set_share_limits(ids, float(s.get("ratio", -2)), int(s.get("seedingTime", -2)),
                                 int(s.get("inactiveSeedingTime", -2)))
        return ok()

    async def location(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.set_location(self._ids(body), str(body.get("path", "")))
        return ok()

    async def rename(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.rename(str(body["id"]), str(body.get("name", "")))
        return ok()

    async def t_properties(self, request: web.Request) -> web.Response:
        e = self._entry(request)
        return ok(await self._run(details.properties, e, time.time()))

    async def t_files(self, request: web.Request) -> web.Response:
        return ok(await self._run(details.files, self._entry(request)))

    async def t_peers(self, request: web.Request) -> web.Response:
        return ok(await self._run(details.peers, self._entry(request)))

    async def t_trackers(self, request: web.Request) -> web.Response:
        b = self.prefs["bittorrent"]
        return ok(await self._run(details.trackers, self._entry(request), b["dht"], b["pex"], b["lsd"]))

    async def t_webseeds(self, request: web.Request) -> web.Response:
        return ok(details.web_seeds(self._entry(request)))

    async def t_pieces(self, request: web.Request) -> web.Response:
        buckets = max(16, min(4096, int(request.query.get("buckets", "1024") or 1024)))
        return ok(await self._run(details.pieces, self._entry(request), buckets))

    async def t_export(self, request: web.Request) -> web.Response:
        e = self._entry(request)
        data = await self._run(torrent_file_bytes, e.handle)
        fname = urllib.parse.quote(f"{_file_stem(e.display_name(), e.id)}.torrent")
        return web.Response(body=data, headers={
            "Content-Type": "application/x-bittorrent",
            "Content-Disposition": f"attachment; filename=\"{e.id}.torrent\"; filename*=UTF-8''{fname}",
        })

    async def export_many(self, request: web.Request) -> web.Response:
        """Desktop only: write the .torrent files of `ids` into the folder `dir`."""
        self._require_desktop(request)
        body = await self._body(request)
        folder = str(body.get("dir", "")).strip()
        if not folder or not os.path.isdir(folder):
            raise ValueError("choose an existing folder")
        written: list[str] = []
        for tid in self._ids(body):
            e = self.engine.get(tid)
            data = await self._run(torrent_file_bytes, e.handle)
            stem = _file_stem(e.display_name(), e.id)
            path = os.path.join(folder, f"{stem}.torrent")
            n = 2
            while os.path.exists(path):
                path = os.path.join(folder, f"{stem} ({n}).torrent")
                n += 1
            await self._run(Path(path).write_bytes, data)
            written.append(path)
        return ok({"written": written})

    async def t_file_priority(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.set_file_priority(request.match_info["id"], [int(i) for i in body.get("indices", [])],
                                      int(body.get("priority", 4)))
        return ok()

    async def t_file_rename(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.rename_path(request.match_info["id"], str(body.get("old", "")), str(body.get("new", "")))
        return ok()

    async def t_add_peers(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        n = self.engine.add_peers(request.match_info["id"], [str(p) for p in body.get("peers", [])])
        return ok({"added": n})

    async def t_edit_trackers(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.edit_trackers(request.match_info["id"], [str(x) for x in body.get("add", [])],
                                  [str(x) for x in body.get("remove", [])],
                                  {str(k): str(v) for k, v in (body.get("edit") or {}).items()})
        return ok()

    async def t_edit_webseeds(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.edit_web_seeds(request.match_info["id"], [str(x) for x in body.get("add", [])],
                                   [str(x) for x in body.get("remove", [])])
        return ok()

    async def ban_peers(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.ban_peers([str(x) for x in body.get("ips", [])])
        self.hub.emit("prefs", self.prefs.public())
        return ok()

    # ------------------------------------------------- categories & speed
    async def category_set(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.set_category_def(str(body.get("name", "")), str(body.get("savePath", "")),
                                     body.get("oldName") or None)
        return ok()

    async def category_delete(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.delete_categories([str(x) for x in body.get("names", [])])
        return ok()

    async def tags_create(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.create_tags([str(x) for x in body.get("tags", [])])
        return ok()

    async def tags_delete(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.delete_tags([str(x) for x in body.get("tags", [])])
        return ok()

    async def transfer_alt(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.engine.set_alt_speed(bool(body.get("enabled")))
        self.hub.emit("prefs", self.prefs.public())
        return ok()

    async def transfer_limits(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        dl, ul = body.get("dl"), body.get("ul")
        self.engine.set_global_limits(None if dl is None else int(dl), None if ul is None else int(ul))
        self.hub.emit("prefs", self.prefs.public())
        return ok()

    # -------------------------------------------------------------- creator
    async def creator_jobs(self, request: web.Request) -> web.Response:
        self._require_local(request)
        return ok([j.public() for j in self.engine.jobs.values()])

    async def creator_inspect(self, request: web.Request) -> web.Response:
        self._require_local(request)
        body = await self._body(request)
        source = str(body.get("source", "")).strip()
        if not source:
            raise ValueError("choose a file or folder to share")
        return ok(await self.engine.inspect_source(source, dict(body.get("options") or {})))

    async def creator_start(self, request: web.Request) -> web.Response:
        # Local only, like the UI: it reads any file on this computer and can seed it.
        self._require_local(request)
        body = await self._body(request)
        source = str(body.get("source", "")).strip()
        output = str(body.get("output", "")).strip()
        if not source or not output:
            raise ValueError("choose what to share and where to save the .torrent file")
        output = os.path.abspath(output) if not output.endswith(("/", "\\")) else ""
        if output and not output.lower().endswith(".torrent") and not os.path.isdir(output):
            output += ".torrent"
        if not output or os.path.isdir(output) or os.path.basename(output).lower() == ".torrent":
            raise ValueError("that's a folder: give the .torrent file a name too")
        if os.path.exists(output) and not body.get("overwrite"):
            raise FileExistsError(f"{os.path.basename(output)} already exists")
        job = self.engine.create_torrent(source, output, dict(body.get("options") or {}))
        return ok(job.public())

    def _job(self, request: web.Request) -> Any:
        self._require_local(request)
        job = self.engine.jobs.get(request.match_info["id"])
        if job is None:
            raise NotFound(request.match_info["id"])
        return job

    async def creator_cancel(self, request: web.Request) -> web.Response:
        self._job(request).cancelled = True
        return ok()

    async def creator_reveal(self, request: web.Request) -> web.Response:
        self._require_desktop(request)
        job = self._job(request)
        if job.status != "done":
            raise ValueError("the torrent file hasn't been made")
        await self._run(plat.reveal_path, job.output)
        return ok()

    # --------------------------------------------------------------- search
    def _search(self) -> Any:
        if self.search is None:
            raise ValueError("search is not available")
        return self.search

    async def s_plugins(self, request: web.Request) -> web.Response:
        from .search import CATEGORIES

        s = self._search()
        await s._ensure_started()
        return ok({"plugins": s.plugins(), "categories": CATEGORIES})

    async def s_install(self, request: web.Request) -> web.Response:
        s = self._search()
        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            result = None
            async for part in reader:
                if part.name in ("file", "plugin"):
                    result = await s.install_from_file(part.filename or "", bytes(await part.read(decode=False)))
            if result is None:
                raise ValueError("no plugin file uploaded")
            return ok(result)
        body = await self._body(request)
        return ok(await s.install_from_url(str(body.get("url", ""))))

    async def s_uninstall(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self._search().uninstall([str(x) for x in body.get("names", [])])
        return ok()

    async def s_enable(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self._search().set_enabled(str(body.get("name", "")), bool(body.get("enabled")))
        return ok()

    async def s_check_updates(self, request: web.Request) -> web.Response:
        return ok(await self._search().check_updates())

    async def s_official(self, request: web.Request) -> web.Response:
        return ok(await self._search().official_plugins())

    async def s_update(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        return ok(await self._search().update_plugins([str(x) for x in body.get("names", [])]))

    async def s_list(self, request: web.Request) -> web.Response:
        return ok(self._search().searches())

    async def s_start(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        plugins = body.get("plugins")
        sid = await self._search().start_search(str(body.get("query", "")), str(body.get("category", "all")),
                                                plugins if plugins not in (None, "", "enabled") else None)
        return ok({"id": sid})

    async def s_get(self, request: web.Request) -> web.Response:
        offset = int(request.query.get("offset", "0") or 0)
        return ok(self._search().get_search(request.match_info["id"], offset))

    async def s_stop(self, request: web.Request) -> web.Response:
        self._search().stop_search(request.match_info["id"])
        return ok()

    async def s_remove(self, request: web.Request) -> web.Response:
        self._search().remove_search(request.match_info["id"])
        return ok()

    async def s_download(self, request: web.Request) -> web.Response:
        """Resolve a search result; return add-dialog info or add it right away."""
        body = await self._body(request)
        url = str(body.get("url", "")).strip()
        # Results link to magnets and web pages; a remote user mustn't pass a path on this computer.
        self._check_source(request, url)
        source = await self._search().download_link(str(body.get("plugin", "")), url)
        data: bytes | None = None
        if not source.lower().startswith(("magnet:", "http://", "https://")) and os.path.isfile(source):
            path = Path(source).resolve()
            data = await self._run(path.read_bytes)
            # Plugins download into the search tmp folder; never delete anything else.
            tmp = getattr(self.search, "_tmp_dir", None)
            if tmp is not None and path.is_relative_to(Path(tmp).resolve()):
                try:
                    path.unlink()
                except OSError:
                    pass
        if body.get("dialog"):
            info = await (self.engine.inspect(data=data) if data is not None else self.engine.inspect(text=source))
            return ok({"info": info})
        options = AddOptions.from_dict(body.get("options"))
        tid = await (self.engine.add_bytes(data, options) if data is not None else self.engine.add_text(source, options))
        return ok({"id": tid})

    # ------------------------------------------------------------------ rss
    def _add_rss_routes(self, r: web.UrlDispatcher) -> None:
        """RSS routes map 1:1 onto RssManager methods."""
        r.add_get("/api/rss", self.rss_snapshot)
        r.add_post("/api/rss/call", self.rss_call)

    def _rss(self) -> Any:
        if self.rss is None:
            raise ValueError("RSS is not available")
        return self.rss

    async def rss_snapshot(self, request: web.Request) -> web.Response:
        return ok(await _maybe_await(self._rss().snapshot()))

    _RSS_METHODS = {
        "add_feed", "remove_feeds", "update_feed", "add_folder", "remove_folder", "rename_folder", "refresh",
        "articles", "articles_by_feed", "mark_read", "mark_all_read", "rules", "set_rule", "rename_rule",
        "delete_rules", "preview_rule", "clear_episode_history", "snapshot",
    }

    async def rss_call(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        method = str(body.get("method", ""))
        if method not in self._RSS_METHODS or not hasattr(self._rss(), method):
            raise ValueError(f"unknown RSS operation {method!r}")
        args = body.get("args") or {}
        if not isinstance(args, dict):
            raise ValueError("args must be an object")
        try:
            result = await _maybe_await(getattr(self._rss(), method)(**args))
        except KeyError:
            # A feed, folder or rule that's gone (removed in another window, say).
            return fail("It doesn't exist anymore", 404)
        return ok({"result": result})

    # ---------------------------------------------------------- websocket
    async def websocket(self, request: web.Request) -> web.StreamResponse:
        local = request.app["local"]
        ws = web.WebSocketResponse(heartbeat=30.0, compress=not local, max_msg_size=1 << 20)
        await ws.prepare(request)
        client = Client(ws, local, self._full)
        client.push(dumps(self._full()))
        if local and self.hub.pending_local:
            for text in self.hub.pending_local:
                client.push(text)
            self.hub.pending_local.clear()
        self.hub.clients.add(client)
        sender = asyncio.create_task(client.run())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT and msg.data == "resync":
                    client.push(dumps(self._full()))
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.hub.clients.discard(client)
            sender.cancel()
        return ws

    # --------------------------------------------------------------- static
    async def static(self, request: web.Request) -> web.StreamResponse:
        """Built UI files; any other path gets index.html (client-side routing)."""
        if request.path.startswith("/api/"):
            raise web.HTTPNotFound()
        root = self._web.resolve()
        tail = request.match_info.get("tail", "")
        if tail:
            target = (root / tail).resolve()
            if target.is_relative_to(root) and target.is_file():
                return web.FileResponse(target)
            if tail.startswith("assets/"):
                raise web.HTTPNotFound()
        index = root / "index.html"
        if not index.is_file():
            return web.Response(text="Promethea UI is not built. Run `npm run build` in ui/.", content_type="text/plain")
        return web.FileResponse(index)


async def _maybe_await(value: Any) -> Any:
    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
        return await value
    return value


def _complete_dirs(path: str) -> list[str]:
    """Folder suggestions for a partially typed path."""
    path = path.strip().strip('"')
    if not path:
        if sys.platform == "win32":
            return [f"{d}:\\" for d in string.ascii_uppercase if os.path.isdir(f"{d}:\\")]
        return ["/"]
    if os.path.isdir(path) and path.endswith(("/", "\\")):
        parent, prefix = path, ""
    else:
        parent, prefix = os.path.split(path)
    if not parent or not os.path.isdir(parent):
        return []
    out = []
    try:
        with os.scandir(parent) as it:
            for entry in it:
                if entry.name.startswith(".") or not entry.name.lower().startswith(prefix.lower()):
                    continue
                try:
                    if entry.is_dir():
                        out.append(os.path.join(parent, entry.name))
                except OSError:
                    continue
                if len(out) >= 200:
                    break
    except OSError:
        return []
    out.sort(key=str.lower)
    return out[:50]
