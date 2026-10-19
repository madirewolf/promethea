"""Small shared helpers."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write a file so readers never see a half-written version."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def error_text(e: BaseException) -> str:
    """An exception as a person should read it. An OSError's own text leads with "[Errno 2]" and
    quotes its path like a Python string, which doubles every backslash of a Windows path."""
    if isinstance(e, OSError) and e.strerror:
        paths = [os.fsdecode(p) if isinstance(p, (bytes, os.PathLike)) else str(p)
                 for p in (e.filename, e.filename2) if p is not None]
        return f"{e.strerror} ({' → '.join(paths)})" if paths else e.strerror
    return str(e) or type(e).__name__


def atomic_write_json(path: Path, obj: Any) -> None:
    atomic_write_bytes(path, json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"))


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, "rb") as f:
            # utf-8-sig: Notepad may add a byte-order mark when someone edits these by hand.
            return json.loads(f.read().decode("utf-8-sig"))
    except FileNotFoundError:
        return default
    except ValueError:
        # A corrupt file should never stop the app from starting. The default gets saved over
        # it later, so keep what was there.
        with contextlib.suppress(OSError):
            shutil.copyfile(path, path.with_name(path.name + ".bad"))
        return default
    except OSError:
        return default
