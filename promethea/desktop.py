"""The desktop app: the UI in a native window (WebView2, through pywebview), with a tray icon,
notifications, the speeds in the title bar and a window that reopens where it was left.

Threads: the window owns the main thread (pywebview runs WinForms on an STA thread of its own and
waits for it). The engine and the API server run on an asyncio loop in "promethea-core", pystray's
message loop in "promethea-tray", and "promethea-ui" makes the calls into pywebview: those wait for the
GUI thread, so they mustn't run on the core loop, nor on the GUI thread in its event handlers.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import logging
import os
import queue
import random
import socket
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable

from . import APP_NAME
from .app import Core, Instance
from .paths import assets_dir
from .util import atomic_write_json, error_text, read_json

log = logging.getLogger("promethea.desktop")

IS_WINDOWS = sys.platform == "win32"
APP_ID = "Promethea.Desktop"  # groups the taskbar button and notifications under Promethea, not Python
ICON = assets_dir() / "promethea.ico"

# The window's first size and its smallest, in logical pixels.
DEFAULT_SIZE = (1280, 800)
MIN_SIZE = (760, 480)
# The page's --bg-0 and --text-1 (ui/src/styles/tokens.css): the window behind it and the title bar.
DARK = ("#0c0d10", "#ececef")
LIGHT = ("#eff0f3", "#15161a")
LOGO = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" '
    'y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/>'
    '</linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M17.9 4.9 7.6 '
    '18h7.2l-1.4 9.1L23.7 14h-7.2l1.4-9.1Z" fill="#fff"/></svg>'
)

# Torrents that make quitting worth a question (as the UI's isActive).
BUSY_STATES = {"moving", "checkingDL", "checkingUP", "checkingResumeData"}
# What's left of the web view's own context menu: the editing commands, in text fields.
EDIT_MENU = {"undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "emoji", "spellCheck"}
# How long quitting may take before the process just ends.
SHUTDOWN_LIMIT = 60.0

if IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi")
    shell32 = ctypes.WinDLL("shell32")

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    class WINDOWPLACEMENT(ctypes.Structure):
        _fields_ = [("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT),
                    ("ptMinPosition", wintypes.POINT), ("ptMaxPosition", wintypes.POINT),
                    ("rcNormalPosition", wintypes.RECT)]

    def _sig(fn: Any, restype: Any, *argtypes: Any) -> None:
        fn.restype = restype
        fn.argtypes = argtypes

    _sig(user32.MonitorFromRect, wintypes.HMONITOR, ctypes.POINTER(wintypes.RECT), wintypes.DWORD)
    _sig(user32.MonitorFromPoint, wintypes.HMONITOR, wintypes.POINT, wintypes.DWORD)
    _sig(user32.GetCursorPos, wintypes.BOOL, ctypes.POINTER(wintypes.POINT))
    _sig(user32.GetMonitorInfoW, wintypes.BOOL, wintypes.HMONITOR, ctypes.POINTER(MONITORINFO))
    _sig(user32.GetWindowPlacement, wintypes.BOOL, wintypes.HWND, ctypes.POINTER(WINDOWPLACEMENT))
    _sig(user32.GetWindowRect, wintypes.BOOL, wintypes.HWND, ctypes.POINTER(wintypes.RECT))
    _sig(user32.GetWindowLongW, wintypes.LONG, wintypes.HWND, ctypes.c_int)
    _sig(user32.SystemParametersInfoW, wintypes.BOOL, wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
         wintypes.UINT)
    _sig(user32.IsIconic, wintypes.BOOL, wintypes.HWND)
    _sig(user32.ShowWindow, wintypes.BOOL, wintypes.HWND, ctypes.c_int)
    _sig(user32.SetForegroundWindow, wintypes.BOOL, wintypes.HWND)
    _sig(user32.GetForegroundWindow, wintypes.HWND)
    _sig(user32.GetWindowThreadProcessId, wintypes.DWORD, wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    _sig(user32.MessageBoxW, ctypes.c_int, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT)
    _sig(user32.LoadImageW, wintypes.HANDLE, wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
         ctypes.c_int, ctypes.c_int, wintypes.UINT)
    _sig(user32.GetSystemMetrics, ctypes.c_int, ctypes.c_int)
    _sig(dwmapi.DwmSetWindowAttribute, ctypes.c_long, wintypes.HWND, wintypes.DWORD, ctypes.c_void_p,
         wintypes.DWORD)

MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY = 0, 1
SW_RESTORE = 9
GWL_STYLE = -16
WS_MAXIMIZE, WS_MINIMIZE = 0x01000000, 0x20000000
WPF_RESTORETOMAXIMIZED = 0x2
SPI_GETWORKAREA = 0x30
DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR = 20, 35, 36
MB_ICONERROR, MB_SETFOREGROUND = 0x10, 0x10000
IMAGE_ICON, LR_LOADFROMFILE, SM_CXSMICON = 1, 0x10, 49
WM_RBUTTONUP = 0x205


def run_desktop(home: Path, args: argparse.Namespace, sources: list[str], instance: Instance) -> None:
    _prepare_process()
    try:
        DesktopApp(home, args, instance).run(sources)
    except Exception as e:
        log.exception("the desktop app failed")
        _error_box(f"{APP_NAME} stopped because of an error.\n\n{error_text(e)}")
        raise


class _Worker:
    """Runs window and tray calls one at a time, in order, off the threads that mustn't wait."""

    def __init__(self) -> None:
        self._jobs: queue.SimpleQueue[tuple[Callable[..., Any], tuple[Any, ...]] | None] = queue.SimpleQueue()
        self._thread = threading.Thread(target=self._run, name="promethea-ui", daemon=True)
        self._thread.start()

    def __call__(self, fn: Callable[..., Any], *args: Any) -> None:
        self._jobs.put((fn, args))

    def close(self) -> None:
        self._jobs.put(None)
        self._thread.join(5)

    def _run(self) -> None:
        while (job := self._jobs.get()) is not None:
            fn, args = job
            try:
                fn(*args)
            except Exception:  # noqa: BLE001 - one failed call mustn't stop the rest
                log.exception("window call %s failed", getattr(fn, "__name__", fn))


class DesktopApp:
    """The window, the tray icon and the core behind them; the API server's `Desktop`."""

    def __init__(self, home: Path, args: argparse.Namespace, instance: Instance) -> None:
        self.home = home
        self.args = args
        self.instance = instance
        self.debug = bool(os.environ.get("PROMETHEA_DEVTOOLS"))
        self._state_path = home / "desktop.json"
        state = read_json(self._state_path, {})
        self.state: dict[str, Any] = state if isinstance(state, dict) else {}
        # The few settings needed before the core has loaded its own.
        stored = read_json(home / "prefs.json", {})
        startup = stored.get("behavior") if isinstance(stored, dict) else None
        self._startup_behavior: dict[str, Any] = startup if isinstance(startup, dict) else {}

        self.loop = asyncio.new_event_loop()
        self.core: Core | None = None
        self.ready = False  # the core is up and serving the UI
        self.ui = _Worker()
        self.tray: Any = None
        self.window: Any = None
        self._booting: Any = None
        self._sources: list[str] = []
        self._tasks: set[asyncio.Task] = set()
        self._form: Any = None  # pywebview's WinForms form, once it exists
        self._hwnd = 0
        self._url: str | None = None  # the UI's address, if it was ready before the web view
        self._quitting = False
        self._done = threading.Event()  # without a window: set when Promethea should quit
        self._web_set_up = False
        self._lock = threading.Lock()  # window, _url, _web_set_up and _quitting
        self._state_lock = threading.Lock()
        self._title_lock = threading.Lock()
        self._title = APP_NAME
        self._tip = APP_NAME
        self._title_pending = False

    # ------------------------------------------------------------- lifecycle
    def run(self, sources: list[str]) -> None:
        self._sources = sources
        core_thread = threading.Thread(target=self._run_loop, name="promethea-core", daemon=True)
        core_thread.start()
        # The window opens while the engine starts, and goes to the UI once it's up.
        self._booting = asyncio.run_coroutine_threadsafe(self._boot(), self.loop)
        try:
            self.tray = self._start_tray()
            if not self._open_window():
                self._run_in_browser()
        finally:
            self._shutdown(core_thread)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        finally:
            try:
                tasks = asyncio.all_tasks(self.loop)
                for task in tasks:
                    task.cancel()
                if tasks:
                    self.loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
                self.loop.run_until_complete(self.loop.shutdown_asyncgens())
                self.loop.run_until_complete(self.loop.shutdown_default_executor(timeout=5))
            except Exception:  # noqa: BLE001
                log.exception("stopping the event loop failed")
            finally:
                self.loop.close()

    async def _boot(self) -> None:
        try:
            self.core = core = Core(self.home, desktop=self)
            explicit = bool(self.args.port)
            port = self.args.port or _pick_port(self.state.get("port"))
            try:
                port = await core.start(port, fallback=not explicit)
            except BaseException:
                await core.close()
                raise
        except Exception:
            log.exception("startup failed")
            self.quit()  # _shutdown says why
            raise
        core.hub.taps.append(self._on_event)
        core.engine.add_sync_listener(self._on_sync)
        if not explicit and port != self.state.get("port"):
            # The page keeps its layout and history in storage that belongs to its address.
            self._set_state("port", port)
        self.instance.publish(port, core.server.token)
        self.ready = True
        if self._sources:
            task = asyncio.create_task(core.server.open_sources(self._sources))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        self._refresh_title()
        self.ui(self._navigate, core.server.local_url())

    def _shutdown(self, core_thread: threading.Thread) -> None:
        with self._lock:
            self._quitting = True
        # A second launch now waits for this one to finish instead of handing it sources.
        with contextlib.suppress(OSError):
            self.instance.info_path.unlink()
        if self.tray is not None:
            with contextlib.suppress(Exception):
                self.tray.visible = False
                self.tray.stop()
        self.ui.close()
        _exit_if_stuck(2 * SHUTDOWN_LIMIT + 15)
        try:
            self._booting.result(timeout=SHUTDOWN_LIMIT)
        except TimeoutError:
            log.error("still starting after %d seconds; quitting anyway", SHUTDOWN_LIMIT)
        except Exception as e:  # noqa: BLE001 - _boot closed what it had opened
            _error_box(f"{APP_NAME} couldn't start.\n\n{error_text(e)}")
        else:
            try:
                asyncio.run_coroutine_threadsafe(self.core.close(), self.loop).result(timeout=SHUTDOWN_LIMIT)
            except Exception:  # noqa: BLE001
                log.exception("shutting down failed")
        self.loop.call_soon_threadsafe(self.loop.stop)
        core_thread.join(10)

    # ------------------------------------------------------------- the window
    def _open_window(self) -> bool:
        """Show the window and return once it has closed; False if there's no web view to use."""
        try:
            import webview
        except ImportError:
            log.warning("pywebview isn't installed: opening the UI in the browser instead")
            return False
        dark = self._dark()
        hidden = bool(self.args.minimized or self._behavior("startMinimized"))
        with self._lock:
            if self._quitting:  # startup failed already
                return True
            # The splash first, even when the UI is ready: the web view's settings only reach the
            # pages loaded after they're set, and that's once the splash has loaded.
            window = webview.create_window(
                APP_NAME,
                html=_splash(dark),
                min_size=MIN_SIZE,
                hidden=hidden and self.tray is not None,
                minimized=hidden and self.tray is None,
                background_color=(DARK if dark else LIGHT)[0],
                text_select=True,  # the page's CSS decides what can be selected
                **_initial_geometry(self.state.get("window")),
            )
            self.window = window
        window.events.before_show += self._on_before_show
        window.events.before_load += self._on_before_load
        window.events.minimized += self._on_minimized
        try:
            webview.start(gui="edgechromium", debug=self.debug, private_mode=False,
                          storage_path=str(self.home / "webview"), icon=str(ICON) if ICON.exists() else None)
        except Exception:  # noqa: BLE001
            log.exception("the window couldn't be opened")
            with self._lock:
                self.window = None
                self._form = None
            return False
        return True

    def _run_in_browser(self) -> None:
        """Without a web view: the UI opens in the browser, and Promethea runs until it's quit."""
        try:
            self._booting.result()
        except Exception:  # noqa: BLE001 - _shutdown reports it
            return
        if not self._quitting:
            webbrowser.open(self.core.server.local_url())
        while not self._done.wait(0.5):
            pass

    def _navigate(self, url: str) -> None:
        with self._lock:
            window = self.window
            if window is None or not self._web_set_up:
                self._url = url  # loaded once the web view is set up
                return
        window.load_url(url)

    def _on_before_show(self, window: Any) -> None:
        """On the GUI thread, once the form exists and before it first shows."""
        try:
            self._form = form = window.native
            self._hwnd = int(form.Handle.ToInt64())
            form.FormClosing += self._on_form_closing
            # A form that activates with no active control tabs into its first one: a window
            # started hidden has its page loaded by then, and that lands on the page's first
            # button, with its focus ring. With the web view active, activation just focuses it.
            form.ActiveControl = form.browser.webview
            self._apply_theme()
            from Microsoft.Win32 import SystemEvents

            SystemEvents.UserPreferenceChanged += self._on_system_settings
        except Exception:  # noqa: BLE001
            log.exception("setting up the window failed")

    def _on_before_load(self) -> None:
        """On the GUI thread when a page has loaded. The first is the splash: the web view gets
        set up, and then the UI loads, if it's ready."""
        if self._web_set_up:
            return
        self._set_up_web_view()
        with self._lock:
            self._web_set_up = True
            url, self._url = self._url, None
        if url:
            self.ui(self._navigate, url)

    def _set_up_web_view(self) -> None:
        try:
            from Microsoft.Web.WebView2.Core import CoreWebView2WebResourceContext

            browser = (self._form or self.window.native).browser
            web = browser.webview.CoreWebView2
            # pywebview passes every request and response through Python, for events Promethea
            # doesn't use (the requests wait for the GUI thread meanwhile).
            web.RemoveWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All)
            web.WebResourceRequested -= browser.on_web_resource_request
            web.WebResourceResponseReceived -= browser.on_web_resource_response
            if not self.debug:
                web.Settings.AreDefaultContextMenusEnabled = True
                web.ContextMenuRequested += self._on_context_menu
        except Exception:  # noqa: BLE001
            log.exception("setting up the web view failed")

    def _on_context_menu(self, sender: Any, args: Any) -> None:
        """Text fields keep the browser's Cut/Copy/Paste menu, and selected text gets Copy; the
        rest of it (Back, Reload, Save as, Print, Inspect...) doesn't belong in an app."""
        try:
            from Microsoft.Web.WebView2.Core import CoreWebView2ContextMenuItemKind as Kind

            target = args.ContextMenuTarget
            keep = EDIT_MENU if target.IsEditable else {"copy"} if target.HasSelection else set()
            items = args.MenuItems
            for i in range(items.Count - 1, -1, -1):
                if items[i].Kind != Kind.Separator and items[i].Name not in keep:
                    items.RemoveAt(i)
            # Then the separators left at either end or next to each other.
            seps = [items[i].Kind == Kind.Separator for i in range(items.Count)]
            doomed, prev_sep = set(), True  # a separator at the top goes too
            for i, sep in enumerate(seps):
                if sep and prev_sep:
                    doomed.add(i)
                prev_sep = sep
            i = len(seps) - 1
            while i >= 0 and seps[i]:
                doomed.add(i)
                i -= 1
            for i in sorted(doomed, reverse=True):
                items.RemoveAt(i)
            if items.Count == 0:
                args.Handled = True  # no menu at all
        except Exception:  # noqa: BLE001
            log.exception("filtering the context menu failed")

    def _on_form_closing(self, sender: Any, args: Any) -> None:
        """On the GUI thread for every close: the X button, Alt+F4, quitting, signing out."""
        try:
            self._save_placement()
            leaving = str(args.CloseReason) in ("WindowsShutDown", "TaskManagerClosing", "ApplicationExitCall")
            if self._quitting or leaving:
                self._quitting = True
                args.Cancel = False
            elif self.tray is not None and self._behavior("closeToTray"):
                args.Cancel = True
                self.ui(self._hide)
                if not self.state.get("trayHintShown"):
                    self._set_state("trayHintShown", True)
                    self._notify(f"{APP_NAME} is still running",
                                 "It's in the notification area. Right-click its icon to quit.", force=True)
            elif self._should_confirm():
                args.Cancel = True
                self._ask_page_to_quit()
            else:
                self._quitting = True
        except Exception:  # noqa: BLE001
            log.exception("closing the window failed")

    def _on_minimized(self) -> None:
        if self.tray is not None and self._behavior("minimizeToTray") and not self._quitting:
            self.ui(self._hide)

    def _on_system_settings(self, sender: Any, args: Any) -> None:
        # pywebview resets the title bar to the system theme; the app's own may differ.
        self.ui(self._apply_theme)

    def _show(self) -> None:
        if self._form is None:
            if self.window is None and self.ready and not self._quitting:  # the browser fallback
                webbrowser.open(self.core.server.local_url())
            return
        self.window.show()
        if IS_WINDOWS and self._hwnd:
            if user32.IsIconic(self._hwnd):
                user32.ShowWindow(self._hwnd, SW_RESTORE)
            user32.SetForegroundWindow(self._hwnd)

    def _hide(self) -> None:
        if self._form is not None and not self._quitting:
            self.window.hide()

    def _close_window(self) -> None:
        if self.window is not None:
            self.window.destroy()

    def _save_placement(self) -> None:
        if IS_WINDOWS and self._hwnd:
            placement = _placement(self._hwnd)
            if placement:
                self._set_state("window", placement)

    # ------------------------------------------------------------- Desktop (the API server's calls)
    def dialog(self, kind: str, title: str, directory: str, multiple: bool,
               file_types: list[str], save_name: str) -> list[str]:
        """A native file or folder picker (on a worker thread of the core's)."""
        form = self._form
        if form is None:
            raise PermissionError("file dialogs need the Promethea window")
        if not IS_WINDOWS:
            import webview

            kinds = {"open": webview.FileDialog.OPEN, "folder": webview.FileDialog.FOLDER,
                     "save": webview.FileDialog.SAVE}
            picked = self.window.create_file_dialog(kinds[kind], directory=directory, allow_multiple=multiple,
                                                    save_filename=save_name, file_types=tuple(file_types))
            return list(picked or ())
        from System import Func, Type

        out: list[str] = []
        failed: list[BaseException] = []

        def run() -> None:
            try:
                out.extend(_file_dialog(form, kind, title, directory, multiple, file_types, save_name))
            except Exception as e:  # noqa: BLE001
                failed.append(e)

        # On the GUI thread, so the dialog is modal to the window and the window keeps painting.
        form.Invoke(Func[Type](run))
        if failed:
            log.error("the %s dialog failed: %s", kind, failed[0])
            raise RuntimeError(f"couldn't open the dialog: {failed[0]}")
        return out

    def show(self) -> None:
        self.ui(self._show)

    def quit(self) -> None:
        with self._lock:
            self._quitting = True
            window = self.window
        self._done.set()
        if window is not None:
            self.ui(self._close_window)

    # ------------------------------------------------------------- quitting with transfers running
    def _should_confirm(self) -> bool:
        """Whether quitting goes through the page's "torrents are still transferring" question."""
        core = self.core
        if not self.ready or core is None or not self._behavior("confirmExitWithActive"):
            return False
        busy = any(_busy(e.snapshot) for e in list(core.engine.entries.values()))
        return busy and any(c.local for c in list(core.hub.clients))

    def _ask_page_to_quit(self) -> None:
        self.loop.call_soon_threadsafe(self.core.hub.emit_local, "app.quit", {})

    # ------------------------------------------------------------- tray
    def _start_tray(self) -> Any:
        try:
            import pystray
            from PIL import Image
        except ImportError:
            log.warning("pystray isn't installed: running without a tray icon")
            return None
        app = self

        class Tray(pystray.Icon):  # type: ignore[misc]
            def _on_notify(self, wparam: int, lparam: int) -> None:
                if lparam == WM_RBUTTONUP:
                    self.update_menu()  # built as it opens, so its check mark is current
                super()._on_notify(wparam, lparam)

            def _assert_icon_handle(self) -> None:
                # The icon file's own small frame, rather than a big one the shell shrinks.
                if not self._icon_handle and IS_WINDOWS and ICON.exists():
                    size = user32.GetSystemMetrics(SM_CXSMICON)
                    self._icon_handle = user32.LoadImageW(None, str(ICON), IMAGE_ICON, size, size, LR_LOADFROMFILE)
                if not self._icon_handle:
                    super()._assert_icon_handle()

        def ready(item: Any) -> bool:
            return app.ready

        def alt_on(item: Any) -> bool:
            return bool(app.ready and app.core.engine.alt_speed)

        menu = pystray.Menu(
            pystray.MenuItem(f"Open {APP_NAME}", self._tray_open, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Alternative speed limits", self._tray_alt, checked=alt_on, enabled=ready),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Start all", self._tray_start_all, enabled=ready),
            pystray.MenuItem("Stop all", self._tray_stop_all, enabled=ready),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(f"Quit {APP_NAME}", self._tray_quit),
        )
        try:
            image = Image.open(ICON) if ICON.exists() else Image.new("RGBA", (32, 32), "#8b5cf6")
            tray = Tray("promethea", image, APP_NAME, menu)
            threading.Thread(target=tray.run, name="promethea-tray", daemon=True).start()
        except Exception:  # noqa: BLE001
            log.exception("the tray icon couldn't be created")
            return None
        return tray

    # Menu actions run on the tray's thread, which mustn't wait on the window or the core.
    def _tray_open(self) -> None:
        self.ui(self._show)

    def _tray_alt(self) -> None:
        self._on_loop(self._toggle_alt)

    def _tray_start_all(self) -> None:
        self._on_loop(lambda: self.core.engine.start_all())

    def _tray_stop_all(self) -> None:
        self._on_loop(lambda: self.core.engine.stop_all())

    def _tray_quit(self) -> None:
        self.ui(self._quit_from_tray)

    def _quit_from_tray(self) -> None:
        if self._should_confirm():
            self._show()
            self._ask_page_to_quit()
        else:
            self.quit()

    def _toggle_alt(self) -> None:
        engine = self.core.engine
        engine.set_alt_speed(not engine.alt_speed)
        self.core.hub.emit("prefs", self.core.prefs.public())

    def _on_loop(self, fn: Callable[..., Any], *args: Any) -> None:
        if self.ready:
            self.loop.call_soon_threadsafe(fn, *args)

    # ------------------------------------------------------------- core events
    def _on_event(self, name: str, data: dict) -> None:
        """Every event the core sends the UI; notifications for the ones that matter when the
        window isn't in front."""
        if name == "prefs":
            self._refresh_title()
            self.ui(self._apply_theme)
            return
        behavior = self.core.prefs["behavior"]
        if name == "torrent.finished" and behavior.get("notifyOnComplete", True):
            self._notify("Download complete", str(data.get("name") or ""))
        elif name == "torrent.error" and behavior.get("notifyOnError", True):
            self._notify(str(data.get("name") or "Torrent error"), str(data.get("message") or ""))
        elif name == "creator" and data.get("status") in ("done", "error"):
            output = os.path.basename(str(data.get("output") or ""))
            if data["status"] == "done":
                self._notify("Torrent created", output)
            else:
                error = str(data.get("error") or "")
                self._notify(f"Couldn't create {output or 'the torrent'}", error[:1].upper() + error[1:])

    def _on_sync(self, delta: dict) -> None:
        if "server" in delta:
            self._refresh_title()

    def _notify(self, title: str, message: str, force: bool = False) -> None:
        if self.tray is None or (not force and _is_foreground()):
            return  # the page shows its own toast
        self.ui(self._show_notification, _clip(title, 63), _clip(message or title, 255))

    def _show_notification(self, title: str, message: str) -> None:
        if not self._quitting:
            self.tray.notify(message, title)

    def _refresh_title(self) -> None:
        """"[D: 3.2 MiB/s, U: 120 KiB/s] Promethea" like qBittorrent, when that's on, and the speeds in
        the tray icon's tooltip."""
        if not self.ready:
            return
        s = self.core.engine.server
        dl, ul = s.get("dlSpeed") or 0, s.get("upSpeed") or 0
        title = APP_NAME
        if self._behavior("speedInTitle") and (dl > 0 or ul > 0):
            title = f"[D: {_fmt_speed(dl)}, U: {_fmt_speed(ul)}] {APP_NAME}"
        tip = f"{APP_NAME}\nDownload: {_fmt_speed(dl)}\nUpload: {_fmt_speed(ul)}"
        if s.get("altSpeed"):
            tip += "\nAlternative speed limits on"
        with self._title_lock:
            if (title, tip) == (self._title, self._tip):
                return
            self._title, self._tip = title, tip
            if self._title_pending:
                return  # the queued update will pick these up
            self._title_pending = True
        self.ui(self._flush_title)

    def _flush_title(self) -> None:
        with self._title_lock:
            title, tip = self._title, self._tip
            self._title_pending = False
        if self._quitting:
            return
        if self._form is not None:
            self.window.set_title(title)
        if self.tray is not None:
            self.tray.title = tip

    # ------------------------------------------------------------- settings
    def _behavior(self, key: str) -> Any:
        if self.core is not None:
            return self.core.prefs["behavior"].get(key)
        return self._startup_behavior.get(key)

    def _dark(self) -> bool:
        theme = self._behavior("theme")
        return theme == "dark" if theme in ("dark", "light") else _system_dark()

    def _apply_theme(self) -> None:
        if IS_WINDOWS and self._hwnd and not self._quitting:
            _style_title_bar(self._hwnd, self._dark())

    def _set_state(self, key: str, value: Any) -> None:
        with self._state_lock:
            self.state[key] = value
            try:
                atomic_write_json(self._state_path, self.state)
            except OSError as e:
                log.warning("couldn't save %s: %s", self._state_path.name, error_text(e))


# ------------------------------------------------------------------ helpers
def _prepare_process() -> None:
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:  # pythonw.exe has no console
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))  # noqa: SIM115

    def log_crash(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is not SystemExit:
            log.error("uncaught exception in thread %s", getattr(args.thread, "name", "?"),
                      exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

    threading.excepthook = log_crash
    if IS_WINDOWS:
        with contextlib.suppress(Exception):
            shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        with contextlib.suppress(Exception):
            user32.SetProcessDPIAware()  # as pywebview does, before anything measures the screen


def _error_box(text: str) -> None:
    if IS_WINDOWS:
        user32.MessageBoxW(None, text, APP_NAME, MB_ICONERROR | MB_SETFOREGROUND)


def _exit_if_stuck(seconds: float) -> None:
    """Quitting mustn't leave a Promethea without a window holding the profile, which the next launch
    would wait on: end the process if it's still here after `seconds`."""
    def reap() -> None:
        time.sleep(seconds)
        log.error("shutting down took over %d seconds; ending the process", seconds)
        logging.shutdown()
        os._exit(0)

    threading.Thread(target=reap, name="promethea-reaper", daemon=True).start()


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))  # as the server binds it
        except OSError:
            return False
    return True


def _pick_port(saved: Any) -> int:
    """The local API's port: the last one, so the page keeps its storage, which belongs to its
    address (if something else has taken it, the server falls back to any free one); on first
    run, a free one below the range the system hands out for connections."""
    if isinstance(saved, int) and 1024 <= saved <= 65535:
        return saved
    for port in random.sample(range(20000, 40000), 20):
        if _port_free(port):
            return port
    return 0


def _initial_geometry(saved: Any) -> dict[str, Any]:
    """create_window's position and size (logical pixels) for the saved placement, or a default
    size, centred, when there's none or it's on no screen now."""
    width, height = DEFAULT_SIZE
    if not IS_WINDOWS:
        return {"width": width, "height": height}
    k = _scale()
    if isinstance(saved, dict):
        try:
            x, y, w, h = (int(saved[key]) for key in ("x", "y", "width", "height"))
        except (KeyError, TypeError, ValueError):
            pass
        else:
            # Its title bar has to be on a screen, or the window couldn't be dragged back.
            strip = wintypes.RECT(x + 32, y, x + w - 32, y + round(32 * k))
            work = _work_area(strip) if w > 96 and h > 32 else None
            if work is not None:
                return {
                    "x": round(x / k), "y": round(y / k),
                    "width": round(min(w, work.right - work.left) / k),
                    "height": round(min(h, work.bottom - work.top) / k),
                    "maximized": bool(saved.get("maximized")),
                }
    # Centred on the screen in use (WinForms' own centring doesn't manage that here).
    work = _work_area()
    if work is None:
        return {"width": width, "height": height}
    avail_w, avail_h = (work.right - work.left) / k, (work.bottom - work.top) / k
    width = max(MIN_SIZE[0], min(width, int(avail_w * 0.92)))
    height = max(MIN_SIZE[1], min(height, int(avail_h * 0.92)))
    return {"x": round(work.left / k + (avail_w - width) / 2), "y": round(work.top / k + (avail_h - height) / 2),
            "width": width, "height": height}


def _placement(hwnd: int) -> dict[str, Any] | None:
    """The window's normal (not maximized) position and size in screen pixels, and whether it's
    maximized, read when it closes."""
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    wp = WINDOWPLACEMENT()
    wp.length = ctypes.sizeof(WINDOWPLACEMENT)
    if not user32.GetWindowPlacement(hwnd, ctypes.byref(wp)):
        return None
    if style & (WS_MAXIMIZE | WS_MINIMIZE):
        # The normal position is in workspace coordinates, from the primary work area's corner.
        n, work = wp.rcNormalPosition, wintypes.RECT()
        user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(work), 0)
        r = wintypes.RECT(n.left + work.left, n.top + work.top, n.right + work.left, n.bottom + work.top)
    else:
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return None
    maximized = bool(style & WS_MAXIMIZE) or bool(style & WS_MINIMIZE and wp.flags & WPF_RESTORETOMAXIMIZED)
    return {"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top, "maximized": maximized}


def _scale() -> float:
    """Physical pixels per logical one (the process is system-DPI aware, as pywebview has it)."""
    try:
        return max(1.0, user32.GetDpiForSystem() / 96)
    except (AttributeError, OSError):
        return 1.0


def _work_area(rect: Any = None) -> Any:
    """The work area of the monitor `rect` is mostly on (None if it's on none), or of the one
    with the mouse pointer."""
    if rect is None:
        pointer = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pointer))
        monitor = user32.MonitorFromPoint(pointer, MONITOR_DEFAULTTOPRIMARY)
    else:
        monitor = user32.MonitorFromRect(ctypes.byref(rect), MONITOR_DEFAULTTONULL)
    if not monitor:
        return None
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return None
    return info.rcWork


def _system_dark() -> bool:
    if not IS_WINDOWS:
        return True
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def _style_title_bar(hwnd: int, dark: bool) -> None:
    """A title bar in the page's own colors on Windows 11 (Windows 10 takes just the dark mode)."""
    bg, fg = DARK if dark else LIGHT
    for attr, value in ((DWMWA_USE_IMMERSIVE_DARK_MODE, int(dark)), (DWMWA_CAPTION_COLOR, _colorref(bg)),
                        (DWMWA_TEXT_COLOR, _colorref(fg))):
        v = wintypes.DWORD(value)
        dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v))


def _colorref(color: str) -> int:
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return r | g << 8 | b << 16


def _splash(dark: bool) -> str:
    """The window's page while the engine starts: the logo, fading in if that takes a moment."""
    return (
        f"<!doctype html><html><head><meta charset='utf-8'><title>{APP_NAME}</title><style>"
        f"html,body{{margin:0;height:100%;overflow:hidden;background:{(DARK if dark else LIGHT)[0]}}}"
        "body{display:grid;place-items:center}"
        "svg{width:64px;height:64px;opacity:0;animation:in .5s ease .4s forwards}"
        "@keyframes in{to{opacity:1}}"
        f"</style></head><body>{LOGO}</body></html>"
    )


def _file_dialog(form: Any, kind: str, title: str, directory: str, multiple: bool,
                 file_types: list[str], save_name: str) -> list[str]:
    """On the GUI thread: the picker, modal to `form`. Folders get the modern picker pywebview
    builds out of the file dialog; WinForms' own folder browser is the old tree."""
    import System.Windows.Forms as WinForms
    from webview.platforms.winforms import OpenFolderDialog
    from webview.util import parse_file_type

    start = directory if directory and os.path.isdir(directory) else None
    if kind == "folder":
        return list(OpenFolderDialog.show(form, start, multiple, title or None) or ())
    filters = []
    for spec in file_types:
        try:
            filters.append("{0} ({1})|{1}".format(*parse_file_type(spec)))
        except ValueError:
            log.warning("ignoring the file type %r", spec)
    dlg = WinForms.OpenFileDialog() if kind == "open" else WinForms.SaveFileDialog()
    try:
        dlg.Filter = "|".join(filters) or "All files (*.*)|*.*"
        dlg.RestoreDirectory = True
        if title:
            dlg.Title = title
        if start:
            dlg.InitialDirectory = start
        if kind == "open":
            dlg.Multiselect = multiple
        else:
            dlg.OverwritePrompt = False  # the app asks itself, when it's about to write
            if save_name:
                dlg.FileName = save_name
            ext = filters[0].rsplit("|", 1)[1].split(";")[0].lstrip("*.") if filters else ""
            if ext and ext != "*":
                dlg.DefaultExt = ext
        if dlg.ShowDialog(form) != WinForms.DialogResult.OK:
            return []
        return list(dlg.FileNames) if kind == "open" else [dlg.FileName]
    finally:
        dlg.Dispose()


def _is_foreground() -> bool:
    """Whether the window in front is one of Promethea's (its own, or one of its dialogs)."""
    if not IS_WINDOWS:
        return False
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return False
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value == os.getpid()


def _busy(snapshot: dict | None) -> bool:
    s = snapshot or {}
    return (s.get("dlSpeed") or 0) > 0 or (s.get("upSpeed") or 0) > 0 or s.get("state") in BUSY_STATES


_UNITS = ("B", "KiB", "MiB", "GiB", "TiB", "PiB")


def _fmt_speed(n: float) -> str:
    """As the UI's formatSpeed(n, "0 B/s"): 0 B/s, 512 B/s, 3.21 MiB/s, 45.6 KiB/s, 120 KiB/s."""
    if not n or n <= 0:
        return "0 B/s"
    if n < 1024:
        return f"{round(n)} B/s"
    i, v = 0, float(n)
    while v >= 1024 and i < len(_UNITS) - 1:
        v /= 1024
        i += 1
    return f"{v:.{0 if v >= 100 else 1 if v >= 10 else 2}f} {_UNITS[i]}/s"


def _clip(text: str, limit: int) -> str:
    """`text` in at most `limit` UTF-16 units (the size of the tray's text fields)."""
    if len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    out, used = [], 0
    for ch in text:
        used += 2 if ord(ch) > 0xFFFF else 1
        if used > limit - 1:
            break
        out.append(ch)
    return "".join(out) + "…"
