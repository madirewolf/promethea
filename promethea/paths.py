"""Filesystem locations used by Promethea."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Directory for settings, resume data, RSS, search plugins and logs.

    Override with the PROMETHEA_HOME environment variable (used by tests).
    """
    env = os.environ.get("PROMETHEA_HOME")
    if env:
        base = Path(env)
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Promethea"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Promethea"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "promethea"
    base.mkdir(parents=True, exist_ok=True)
    return base


def default_download_dir() -> Path:
    downloads = Path.home() / "Downloads"
    return downloads if downloads.is_dir() else Path.home()


def web_dir() -> Path:
    """Built frontend assets (produced by `npm run build` in ui/)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "promethea" / "web"
    return Path(__file__).resolve().parent / "web"


def assets_dir() -> Path:
    """The app icon (made by tools/make_icon.py)."""
    return web_dir().parent / "assets"
