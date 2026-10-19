"""Torrent creation: listing what's shared, and hashing it in a process of its own.

The hashing runs in a child process because libtorrent can't stop set_piece_hashes partway:
raising from its progress callback unwinds while its disk threads still hold the state, which
now and then crashes the whole process. Stopping a job kills the child instead. This module
stays clear of the engine package so the child starts quickly."""

from __future__ import annotations

import multiprocessing
import os
import stat
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import libtorrent as lt

from .util import atomic_write_bytes, error_text

MIN_PIECE = 16 * 1024
MAX_PIECE = 128 * 1024 * 1024  # libtorrent won't load a torrent with bigger pieces
# How long the dialog's preview may spend listing a folder before it settles for a partial count.
INSPECT_SECONDS = 3.0
_HIDDEN = getattr(stat, "FILE_ATTRIBUTE_HIDDEN", 0)

Files = list[tuple[str, int]]  # (path from the shared folder's parent, size)


@dataclass
class CreateJob:
    id: str
    source: str
    output: str
    status: str = "running"  # running | done | error | cancelled
    progress: float = 0.0
    error: str = ""
    num_pieces: int = 0
    piece_size: int = 0
    started: float = field(default_factory=time.time)
    seed: bool = False  # add it to the transfers once it's made
    cancelled: bool = False
    result_bytes: bytes = b""

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "output": self.output,
            "status": self.status,
            "progress": round(self.progress, 4),
            "error": self.error,
            "numPieces": self.num_pieces,
            "pieceSize": self.piece_size,
            "started": self.started,
            "seed": self.seed,
        }


class _Cancelled(Exception):
    pass


class _Cutoff(Exception):
    """The preview's folder listing ran out of time, or a newer one replaced it."""


# ------------------------------------------------------------------ what goes in
def _hidden(e: os.DirEntry) -> bool:
    """Dot files and folders, and (on Windows) ones marked hidden, like Thumbs.db."""
    if e.name.startswith("."):
        return True
    try:
        attrs = getattr(e.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attrs & _HIDDEN)


def _walk(src: str, check: Callable[[], None], out: Files) -> None:
    """Add the files in folder `src` to `out`, in name order. Hidden files are left out, as
    qBittorrent does, and linked folders aren't followed (they can loop). `check` runs before
    each folder and raises to stop."""
    pending = [(src, os.path.basename(src))]
    while pending:
        check()
        path, rel = pending.pop()
        try:
            with os.scandir(path) as it:
                entries = sorted(it, key=lambda e: e.name)
        except OSError:
            continue  # a folder that can't be read
        folders = []
        for e in entries:
            try:
                if _hidden(e):
                    continue
                if e.is_dir():
                    if not (e.is_symlink() or getattr(e, "is_junction", lambda: False)()):
                        folders.append((e.path, f"{rel}/{e.name}"))
                elif e.is_file():
                    out.append((f"{rel}/{e.name}", e.stat().st_size))
            except OSError:
                continue
        pending.extend(reversed(folders))


def source_files(source: str, check: Callable[[], None] = lambda: None,
                 out: Files | None = None) -> tuple[str, Files]:
    """The absolute path of what's shared and the files that go in. A file picked on its
    own always goes in, hidden or not. `out` collects them as they're found."""
    src = os.path.abspath(source)
    if not os.path.exists(src):
        raise ValueError("nothing exists at that path")
    if not os.path.basename(src):
        raise ValueError("that's a whole drive: pick a folder on it")
    files: Files = [] if out is None else out
    if os.path.isdir(src):
        _walk(src, check, files)
    else:
        files.append((os.path.basename(src), os.path.getsize(src)))
    if not files:
        raise ValueError("there are no files to share there")
    if not any(size for _, size in files):
        raise ValueError("there's nothing to share: " + ("the files are all empty" if len(files) > 1 else "the file is empty"))
    return src, files


def _make(files: Files, opts: dict[str, Any]) -> Any:
    fmt = opts.get("format", "hybrid")
    if fmt not in ("hybrid", "v1", "v2"):
        raise ValueError("format must be hybrid, v1 or v2")
    # No "optimize alignment": libtorrent 2 ignores that flag. Hybrid and v2 torrents are
    # always piece aligned, and v1 ones keep the classic layout, as in qBittorrent.
    flags = 0
    if fmt == "v1":
        flags |= int(lt.create_torrent.v1_only)
    elif fmt == "v2":
        flags |= int(lt.create_torrent.v2_only)
    piece_size = int(opts.get("pieceSize") or 0)
    if piece_size and (piece_size < MIN_PIECE or piece_size > MAX_PIECE or piece_size & (piece_size - 1)):
        raise ValueError("the piece size has to be a power of two from 16 KiB to 128 MiB")
    try:
        return lt.create_torrent([lt.create_file_entry(path, size) for path, size in files], piece_size, flags)
    except RuntimeError as e:
        raise ValueError(str(e)) from e


def inspect(source: str, opts: dict[str, Any], stale: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """What a torrent made from `source` would hold, without hashing anything. A folder that
    takes too long to list (or a call that `stale` says is replaced) gives what was counted
    so far, with "partial" set and no pieces."""
    deadline = time.monotonic() + INSPECT_SECONDS

    def check() -> None:
        if stale() or time.monotonic() > deadline:
            raise _Cutoff()

    files: Files = []
    try:
        src, files = source_files(source, check, files)
    except _Cutoff:
        return {"name": os.path.basename(os.path.abspath(source)), "isDir": True, "files": len(files),
                "size": sum(size for _, size in files), "pieceSize": 0, "numPieces": 0, "partial": True}
    ct = _make(files, opts)
    return {
        "name": os.path.basename(src),
        "isDir": os.path.isdir(src),
        "files": len(files),
        "size": sum(size for _, size in files),
        "pieceSize": ct.piece_length(),
        "numPieces": ct.num_pieces(),
        "partial": False,
    }


# ------------------------------------------------------------------ hashing
def _tiers(text: str) -> list[tuple[str, int]]:
    """Trackers, one per line; a blank line starts a new tier (qBittorrent style)."""
    out, tier = [], 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            if out and out[-1][1] == tier:
                tier += 1
            continue
        out.append((line, tier))
    return out


def _child(conn: Any, source: str, opts: dict[str, Any]) -> None:
    """The child process: lists and hashes, reporting ("pieces", count, size), then
    ("hashed", n) now and then, and finally ("done", torrent bytes) or ("error", text)."""
    try:
        src, files = source_files(source)
        ct = _make(files, opts)
        conn.send(("pieces", ct.num_pieces(), ct.piece_length()))
        for url, tier in _tiers(str(opts.get("trackers") or "")):
            ct.add_tracker(url, tier)
        for url in (u.strip() for u in str(opts.get("urlSeeds") or "").splitlines()):
            if url:
                ct.add_url_seed(url)
        if opts.get("comment"):
            ct.set_comment(str(opts["comment"]))
        ct.set_creator("Promethea")
        if opts.get("private"):
            ct.set_priv(True)

        hashed = [0]
        last = [0.0]

        def progress(_piece: int) -> None:
            # Counted rather than read from the index: pieces don't finish in order.
            hashed[0] += 1
            now = time.monotonic()
            if now - last[0] > 0.1:
                last[0] = now
                conn.send(("hashed", hashed[0]))

        lt.set_piece_hashes(ct, os.path.dirname(src), progress)
        entry = ct.generate()
        if opts.get("source"):
            entry[b"info"][b"source"] = str(opts["source"]).encode("utf-8")
        conn.send(("done", lt.bencode(entry)))
    except (OSError, ValueError, RuntimeError) as e:
        conn.send(("error", error_text(e)))


def _follow(job: CreateJob, proc: Any, conn: Any, on_update: Callable[[CreateJob], None]) -> bytes:
    """Pass the child's progress on to the job until it hands over the torrent."""
    last = 0.0
    while True:
        if job.cancelled:
            raise _Cancelled()
        try:
            if not conn.poll(0.1):
                if not proc.is_alive() and not conn.poll():
                    raise EOFError
                continue
            msg = conn.recv()
        except (EOFError, OSError):
            raise RuntimeError(f"hashing stopped unexpectedly (exit code {proc.exitcode})") from None
        if msg[0] == "pieces":
            job.num_pieces, job.piece_size = msg[1], msg[2]
            on_update(job)
        elif msg[0] == "hashed":
            job.progress = min(1.0, msg[1] / max(1, job.num_pieces))
            now = time.monotonic()
            if now - last > 0.25:
                last = now
                on_update(job)
        elif msg[0] == "error":
            raise ValueError(msg[1])
        else:
            return msg[1]


def _windowless_children() -> None:
    """Under a venv's pythonw.exe, multiprocessing starts the base interpreter's python.exe,
    which opens a console window. Point it at the pythonw.exe beside that instead."""
    if sys.platform != "win32" or getattr(sys, "frozen", False):
        return
    base = Path(getattr(sys, "_base_executable", "") or "")
    if Path(sys.executable).name.lower() != "pythonw.exe" or base.name.lower() != "python.exe":
        return
    quiet = base.with_name("pythonw.exe")
    if quiet.exists():
        sys._base_executable = str(quiet)


def run_job(job: CreateJob, opts: dict[str, Any], on_update: Callable[[CreateJob], None]) -> None:
    _windowless_children()
    ctx = multiprocessing.get_context("spawn")
    conn, child_end = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(child_end, job.source, opts), daemon=True, name="promethea-creator")
    started = False
    try:
        proc.start()
        started = True
        child_end.close()  # so the pipe reports the end when the child is gone
        data = _follow(job, proc, conn, on_update)
        atomic_write_bytes(Path(os.path.abspath(job.output)), data)
        job.result_bytes = data
        job.progress = 1.0
        job.status = "done"
    except _Cancelled:
        job.status = "cancelled"
    except (OSError, ValueError, RuntimeError) as e:
        job.status = "error"
        job.error = error_text(e)
    finally:
        if started:
            if proc.is_alive():
                proc.kill()
            proc.join(10)
        else:
            child_end.close()
        conn.close()
    on_update(job)


def start_job(source: str, output: str, opts: dict[str, Any],
              on_update: Callable[[CreateJob], None]) -> CreateJob:
    job = CreateJob(id=uuid.uuid4().hex[:12], source=source, output=output, seed=bool(opts.get("startSeeding")))
    threading.Thread(target=run_job, args=(job, opts, on_update), daemon=True, name="torrent-creator").start()
    return job
