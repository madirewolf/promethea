"""OS integration: disk space, opening files, recycle bin, sleep inhibition,
external programs, file associations and autostart."""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable

log = logging.getLogger("promethea.platform")

IS_WINDOWS = sys.platform == "win32"


def free_space(path: str) -> int:
    """Free bytes on the volume holding `path` (or its closest existing parent)."""
    p = Path(path) if path else Path.home()
    for candidate in (p, *p.parents):
        try:
            if candidate.exists():
                return shutil.disk_usage(candidate).free
        except OSError:
            continue
    return -1


def open_path(path: str) -> None:
    """Open a file or folder with the default application."""
    if IS_WINDOWS:
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def reveal_path(path: str) -> None:
    """Show a file selected in the system file manager."""
    p = Path(path)
    if IS_WINDOWS:
        if p.exists():
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            open_path(str(p.parent if p.parent.exists() else p))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(p)])
    else:
        open_path(str(p.parent))


def recycle(paths: Iterable[str]) -> bool:
    """Move paths to the Recycle Bin. Returns False if it could not."""
    items = [os.path.abspath(p) for p in paths if os.path.exists(p)]
    if not items:
        return True
    if not IS_WINDOWS:
        return False
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 3
    FOF_SILENT = 0x0004
    FOF_NOCONFIRMATION = 0x0010
    FOF_ALLOWUNDO = 0x0040
    FOF_NOERRORUI = 0x0400
    op = SHFILEOPSTRUCTW()
    op.wFunc = FO_DELETE
    op.pFrom = "\0".join(items) + "\0\0"
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return result == 0 and not op.fAnyOperationsAborted


def delete_paths(paths: Iterable[str]) -> None:
    for p in paths:
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
        except OSError as e:
            log.warning("could not delete %s: %s", p, e)


def remove_empty_dirs(start: str, stop_at: str) -> None:
    """Remove `start` and empty parents, never going above `stop_at`."""
    stop = os.path.normcase(os.path.abspath(stop_at))
    cur = os.path.abspath(start)
    while os.path.normcase(cur).startswith(stop) and os.path.normcase(cur) != stop:
        try:
            os.rmdir(cur)
        except OSError:
            return
        cur = os.path.dirname(cur)


class SleepInhibitor:
    """Keeps the PC awake while transfers are active (Windows only)."""

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001

    def __init__(self) -> None:
        self.active = False

    def set(self, active: bool) -> None:
        if active == self.active or not IS_WINDOWS:
            self.active = active
            return
        import ctypes

        flags = self.ES_CONTINUOUS | (self.ES_SYSTEM_REQUIRED if active else 0)
        ctypes.windll.kernel32.SetThreadExecutionState(flags)
        self.active = active


def run_external(template: str, values: dict[str, str]) -> None:
    """Run a user-configured program with qBittorrent-style placeholders.

    The command is split into arguments *before* substitution and run without a
    shell, so torrent names can never inject extra commands.
    """
    template = template.strip()
    if not template:
        return
    try:
        args = shlex.split(template, posix=not IS_WINDOWS)
    except ValueError as e:
        log.warning("invalid external program command: %s", e)
        return
    if IS_WINDOWS:
        args = [a[1:-1] if len(a) >= 2 and a[0] == a[-1] == '"' else a for a in args]

    def sub(arg: str) -> str:
        out, i = [], 0
        while i < len(arg):
            if arg[i] == "%" and i + 1 < len(arg) and arg[i + 1] in values:
                out.append(values[arg[i + 1]])
                i += 2
            else:
                out.append(arg[i])
                i += 1
        return "".join(out)

    argv = [sub(a) for a in args]
    kwargs: dict = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    except OSError as e:
        log.warning("could not run external program %r: %s", argv[0] if argv else template, e)


# --- Windows shell integration (only run on explicit user request) ---------

def _launch_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    interpreter = pythonw if pythonw.exists() else exe
    return f'"{interpreter}" -m promethea'


def associate_files() -> None:
    """Register Promethea as handler for .torrent files and magnet: links (current user)."""
    if not IS_WINDOWS:
        raise RuntimeError("file association is only supported on Windows")
    import winreg

    cmd = _launch_command() + ' "%1"'
    root = winreg.HKEY_CURRENT_USER
    with winreg.CreateKey(root, r"Software\Classes\Promethea.Torrent") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "Torrent file")
    with winreg.CreateKey(root, r"Software\Classes\Promethea.Torrent\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)
    with winreg.CreateKey(root, r"Software\Classes\.torrent") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "Promethea.Torrent")
        winreg.SetValueEx(k, "Content Type", 0, winreg.REG_SZ, "application/x-bittorrent")
    with winreg.CreateKey(root, r"Software\Classes\magnet") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Magnet link")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(root, r"Software\Classes\magnet\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)
    try:
        import ctypes

        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED
    except Exception:  # noqa: BLE001
        pass


def is_associated() -> bool:
    if not IS_WINDOWS:
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\.torrent") as k:
            value, _ = winreg.QueryValueEx(k, "")
            return value == "Promethea.Torrent"
    except OSError:
        return False


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def set_autostart(enabled: bool) -> None:
    if not IS_WINDOWS:
        raise RuntimeError("autostart is only supported on Windows")
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        if enabled:
            winreg.SetValueEx(k, "Promethea", 0, winreg.REG_SZ, _launch_command() + " --minimized")
        else:
            try:
                winreg.DeleteValue(k, "Promethea")
            except FileNotFoundError:
                pass


def autostart_enabled() -> bool:
    if not IS_WINDOWS:
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, "Promethea")
            return True
    except OSError:
        return False
