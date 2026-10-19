"""Run one qBittorrent-compatible ("nova3") search plugin in a child process.

Usage::

    runner.py info     <engines_dir> <engine>
    runner.py search   <engines_dir> <engine> <category> <query...>
    runner.py download <engines_dir> <engine> <url>

``info`` prints one JSON line describing the plugin. ``search`` lets the plugin
print result lines through ``novaprinter.prettyPrinter``. ``download`` prints
``"<path> <url>"`` for a downloaded .torrent file (or a magnet link). Errors go
to stderr and give a non-zero exit code.

The plugin is imported as ``engines.<engine>`` from ``engines_dir`` -- the same
layout qBittorrent uses -- with this directory on ``sys.path`` for ``helpers``
and ``novaprinter``. Nothing depends on the working directory, so this works
when started with ``python -I``.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.machinery
import importlib.util
import json
import os
import re
import sys
import tempfile
import traceback
import urllib.parse
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_VERSION_RE = re.compile(r"^\s*#\s*VERSION\s*:\s*(\S+)", re.IGNORECASE)


def parse_version_header(text: str) -> str:
    """Return the version from the first ``#VERSION: x.y`` line, or ""."""
    for line in text.splitlines():
        match = _VERSION_RE.match(line)
        if match:
            return match.group(1)
    return ""


def read_plugin_version(path: str | os.PathLike[str]) -> str:
    try:
        with open(path, "rb") as handle:
            return parse_version_header(handle.read(1 << 20).decode("utf-8", "replace"))
    except OSError:
        return ""


def _configure_stdio() -> None:
    for stream, errors in ((sys.stdout, "replace"), (sys.stderr, "backslashreplace")):
        if stream is None:
            continue
        with contextlib.suppress(AttributeError, ValueError, OSError):
            stream.reconfigure(encoding="utf-8", errors=errors, newline="\n", line_buffering=True)


def _prepare(engines_dir: str) -> None:
    sys.dont_write_bytecode = True  # never leave stale .pyc files next to plugins
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)  # helpers, novaprinter
    # Make "engines" a package rooted at engines_dir, like qBittorrent's nova3/engines.
    spec = importlib.machinery.ModuleSpec("engines", None, is_package=True)
    spec.submodule_search_locations = [engines_dir]
    sys.modules["engines"] = importlib.util.module_from_spec(spec)
    if engines_dir not in sys.path:
        sys.path.append(engines_dir)  # last, so plugins can never shadow real modules
    tmp = os.environ.get("PROMETHEA_SEARCH_TMP")
    if tmp and os.path.isdir(tmp):
        tempfile.tempdir = tmp


def _load_engine(engines_dir: str, name: str) -> Any:
    if not _NAME_RE.match(name):
        raise SystemExit(f"Invalid plugin name: {name!r}")
    engines_dir = os.path.abspath(engines_dir)
    if not os.path.isfile(os.path.join(engines_dir, name + ".py")):
        raise SystemExit(f"Plugin file not found: {name}.py")
    _prepare(engines_dir)
    module = importlib.import_module("engines." + name)
    engine_class = getattr(module, name, None)
    if engine_class is None or not callable(engine_class):
        raise SystemExit(f"The plugin must define a class named '{name}'")
    return engine_class


def _cmd_info(engines_dir: str, name: str) -> int:
    # Keep stdout clean for the JSON line even if the plugin prints while importing.
    with contextlib.redirect_stdout(sys.stderr):
        engine_class = _load_engine(engines_dir, name)
        if not callable(getattr(engine_class, "search", None)):
            raise SystemExit(f"Class '{name}' has no search() method")
        categories = getattr(engine_class, "supported_categories", None)
        if categories is None:
            supported = None
        else:
            keys = categories.keys() if hasattr(categories, "keys") else categories
            supported = sorted({str(key) for key in keys})
    info = {
        "name": str(getattr(engine_class, "name", "") or name),
        "url": str(getattr(engine_class, "url", "") or ""),
        "categories": [key for key in (supported or []) if key != "all"],
        "supported": supported,
        "version": read_plugin_version(os.path.join(os.path.abspath(engines_dir), name + ".py")),
        "download": callable(getattr(engine_class, "download_torrent", None)),
    }
    print(json.dumps(info))
    return 0


def _cmd_search(engines_dir: str, name: str, category: str, words: list[str]) -> int:
    engine = _load_engine(engines_dir, name)()
    what = urllib.parse.quote(" ".join(words))
    if hasattr(engine, "supported_categories"):
        try:
            supported = category in engine.supported_categories
        except TypeError:
            supported = False
        if supported:
            engine.search(what, category)
    else:
        engine.search(what)
    return 0


def _cmd_download(engines_dir: str, name: str, url: str) -> int:
    engine = _load_engine(engines_dir, name)()
    if callable(getattr(engine, "download_torrent", None)):
        engine.download_torrent(url)
    else:
        import helpers  # resolved from _HERE by _prepare()

        print(helpers.download_file(url))
    return 0


def main(argv: list[str]) -> int:
    _configure_stdio()
    mode = argv[0] if argv else ""
    try:
        if mode == "info" and len(argv) == 3:
            return _cmd_info(argv[1], argv[2])
        if mode == "search" and len(argv) >= 5:
            return _cmd_search(argv[1], argv[2], argv[3], argv[4:])
        if mode == "download" and len(argv) == 4:
            return _cmd_download(argv[1], argv[2], argv[3])
        print(__doc__, file=sys.stderr)
        return 2
    except SystemExit as exc:
        if exc.code is None or isinstance(exc.code, int):
            return exc.code or 0
        print(exc.code, file=sys.stderr)
        return 1
    except BaseException:  # noqa: BLE001 - report every plugin failure on stderr
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    code = main(sys.argv[1:])
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.flush()
    # Skip interpreter teardown: plugins sometimes leave non-daemon threads behind.
    os._exit(code)
