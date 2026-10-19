"""On-demand detail views for a single torrent (files, peers, trackers, pieces)."""

from __future__ import annotations

import time
from typing import Any

import libtorrent as lt

from .model import (
    Q_DISTRIBUTED_COPIES,
    Q_LAST_SEEN_COMPLETE,
    Q_PIECES,
    Q_SAVE_PATH,
    Entry,
    _secs,
    payload_rates,
    ratio_of,
)

PI = lt.peer_info
#: Appended to unfinished files when "append extension" is on. The UI never shows it.
INCOMPLETE_EXT = ".!sg"
UTP_SOCKET = 1 << 17
SRC_TRACKER, SRC_DHT, SRC_PEX, SRC_LSD, SRC_RESUME, SRC_INCOMING = 1, 2, 4, 8, 16, 32

_CATEGORIES = {
    "system": lt.system_category,
    "generic": lt.generic_category,
    "libtorrent": lt.libtorrent_category,
    "http": lt.http_category,
    "upnp": lt.upnp_category,
    "bdecode": lt.bdecode_category,
    "socks": lt.socks_category,
    "i2p": lt.i2p_category,
}


def error_text(err: dict[str, Any] | None) -> str:
    if not err or not err.get("value"):
        return ""
    cat = _CATEGORIES.get(err.get("category", ""))
    if cat is None:
        return f"{err.get('category')} error {err.get('value')}"
    try:
        return lt.error_code(int(err["value"]), cat()).message()
    except Exception:  # noqa: BLE001
        return f"error {err.get('value')}"


def file_paths(e: Entry) -> list[str]:
    """Current (possibly renamed) file paths, '/' separated."""
    ti = e.handle.torrent_file()
    if ti is None:
        return []
    fs = ti.layout()
    renamed = e.handle.get_renamed_files()
    out = []
    for i in range(fs.num_files()):
        try:
            p = renamed.file_path(fs, i)
        except Exception:  # noqa: BLE001
            p = fs.file_path(i)
        out.append(p.replace("\\", "/"))
    return out


def display_path(path: str) -> str:
    """A file path as the user sees it (without the incomplete-file extension)."""
    return path[: -len(INCOMPLETE_EXT)] if path.endswith(INCOMPLETE_EXT) else path


def real_files(e: Entry) -> list[tuple[int, str]]:
    """(index, current path) for every file except pad files."""
    ti = e.handle.torrent_file()
    if ti is None:
        return []
    fs = ti.layout()
    pad = int(fs.flag_pad_file)
    paths = file_paths(e)
    return [(i, paths[i]) for i in range(fs.num_files()) if not fs.file_flags(i) & pad]


def properties(e: Entry, now: float) -> dict[str, Any]:
    h = e.handle
    st = h.status(Q_DISTRIBUTED_COPIES | Q_LAST_SEEN_COMPLETE | Q_SAVE_PATH)
    ti = h.torrent_file()
    ih = h.info_hashes()
    active = _secs(st.active_duration) or 0
    seeding = _secs(st.seeding_duration) or 0
    finished = _secs(st.finished_duration) or 0
    dl_time = max(1.0, active - finished)
    next_announce = 0
    try:
        na = st.next_announce
        next_announce = int(_secs(na) or 0)
    except Exception:  # noqa: BLE001
        pass
    out: dict[str, Any] = {
        "id": e.id,
        "name": e.display_name(),
        "savePath": e.meta.savePath or st.save_path,
        "currentPath": st.save_path,
        "downloadPath": e.meta.downloadPath,
        "comment": e.meta.comment,
        "createdBy": e.meta.createdBy,
        "creationDate": e.meta.creationDate or (int(ti.creation_date() or 0) if ti else 0),
        "pieceSize": ti.piece_length() if ti else 0,
        "numPieces": ti.num_pieces() if ti else 0,
        "piecesHave": st.num_pieces,
        "totalSize": ti.total_size() if ti else 0,
        "size": st.total_wanted,
        "private": bool(ti.priv()) if ti else False,
        "infohashV1": str(ih.v1) if ih.has_v1() else "",
        "infohashV2": str(ih.v2) if ih.has_v2() else "",
        "magnet": lt.make_magnet_uri(h),
        "addedOn": int(st.added_time or e.meta.addedOn or 0),
        "completedOn": int(st.completed_time or 0),
        "lastSeenComplete": int(st.last_seen_complete or 0),
        "timeActive": int(active),
        "seedingTime": int(seeding),
        "downloaded": st.all_time_download,
        "dlSession": st.total_payload_download,
        "uploaded": st.all_time_upload,
        "upSession": st.total_payload_upload,
        "wasted": st.total_failed_bytes + st.total_redundant_bytes,
        "connections": st.num_connections,
        "connectionsLimit": st.connections_limit,
        "seeds": st.num_seeds,
        "seedsTotal": max(st.num_complete, st.list_seeds),
        "peers": max(0, st.num_peers - st.num_seeds),
        "peersTotal": max(st.num_incomplete, st.list_peers - st.list_seeds),
        "dlSpeed": payload_rates(st)[0],
        "upSpeed": payload_rates(st)[1],
        "dlSpeedAvg": int(st.all_time_download / dl_time) if active else 0,
        "upSpeedAvg": int(st.all_time_upload / max(1.0, active)) if active else 0,
        "dlLimit": max(0, h.download_limit()),
        "upLimit": max(0, h.upload_limit()),
        "ratio": round(ratio_of(st), 3),
        "reannounceIn": next_announce,
        "availability": round(st.distributed_copies, 3) if st.distributed_copies >= 0 else -1,
        "error": e.error,
        "hasMetadata": bool(st.has_metadata),
        "maxConnections": h.max_connections(),
        "maxUploads": h.max_uploads(),
    }
    return out


def files(e: Entry) -> dict[str, Any]:
    h = e.handle
    ti = h.torrent_file()
    if ti is None:
        return {"hasMetadata": False, "files": []}
    fs = ti.layout()
    pad = int(fs.flag_pad_file)
    paths = file_paths(e)
    progress = h.file_progress()
    prios = e.file_priorities()
    avail = h.piece_availability()
    have = None
    if avail:
        st = h.status(Q_PIECES)
        have = st.pieces
    piece_len = ti.piece_length()
    out = []
    for i in range(fs.num_files()):
        if fs.file_flags(i) & pad:
            continue
        size = fs.file_size(i)
        first = fs.file_offset(i) // piece_len if piece_len else 0
        last = (fs.file_offset(i) + max(0, size - 1)) // piece_len if piece_len else 0
        availability = -1.0
        if avail and size > 0:
            seg = avail[first:last + 1]
            hv = have[first:last + 1] if have else [False] * len(seg)
            if seg:
                ok = sum(1 for a, got in zip(seg, hv) if a > 0 or got)
                availability = ok / len(seg)
        out.append({
            "index": i,
            "path": display_path(paths[i] if i < len(paths) else fs.file_path(i)),
            "size": size,
            "progress": (progress[i] / size) if size else 1.0,
            "priority": prios[i] if i < len(prios) else 4,
            "availability": round(availability, 4),
            "firstPiece": first,
            "lastPiece": last,
        })
    return {"hasMetadata": True, "files": out}


def _peer_flags(p: Any) -> str:
    f = int(p.flags)
    src = int(p.source)
    out = []
    interesting = f & PI.interesting
    choked = f & PI.choked
    remote_interested = f & PI.remote_interested
    remote_choked = f & PI.remote_choked
    if interesting:
        out.append("d" if remote_choked else "D")
    if remote_interested:
        out.append("u" if choked else "U")
    if not remote_choked and not interesting:
        out.append("K")
    if not choked and not remote_interested:
        out.append("?")
    if f & PI.optimistic_unchoke:
        out.append("O")
    if f & PI.snubbed:
        out.append("S")
    if not (f & PI.outgoing_connection):
        out.append("I")
    if f & PI.rc4_encrypted:
        out.append("E")
    elif f & PI.plaintext_encrypted:
        out.append("e")
    if f & UTP_SOCKET:
        out.append("P")
    if src & SRC_PEX:
        out.append("X")
    if src & SRC_DHT:
        out.append("H")
    if src & SRC_LSD:
        out.append("L")
    if f & PI.holepunched:
        out.append("h")
    return " ".join(out)


def peers(e: Entry) -> list[dict[str, Any]]:
    out = []
    for p in e.handle.get_peer_info():
        f = int(p.flags)
        if f & PI.connecting or f & PI.handshake:
            continue
        ip, port = p.ip
        client = p.client
        if isinstance(client, bytes):
            client = client.decode("utf-8", "replace")
        conn_type = int(p.connection_type)
        if conn_type != 0:
            conn = "Web"
        elif f & UTP_SOCKET:
            conn = "µTP"
        else:
            conn = "BT"
        out.append({
            "id": f"{ip}:{port}",
            "ip": ip,
            "port": port,
            "client": client or "Unknown",
            "connection": conn,
            "flags": _peer_flags(p),
            "progress": round(p.progress, 4),
            "dlSpeed": p.payload_down_speed,
            "upSpeed": p.payload_up_speed,
            "downloaded": p.total_download,
            "uploaded": p.total_upload,
            "seed": bool(f & PI.seed),
            "source": int(p.source),
        })
    return out


def trackers(e: Entry, dht_enabled: bool, pex_enabled: bool, lsd_enabled: bool) -> list[dict[str, Any]]:
    h = e.handle
    ih = h.info_hashes()
    use_v1, use_v2 = ih.has_v1(), ih.has_v2()
    now = time.time()
    rows: list[dict[str, Any]] = []

    # Pseudo rows for DHT / PeX / LSD, like qBittorrent.
    counts = {SRC_DHT: 0, SRC_PEX: 0, SRC_LSD: 0}
    try:
        for p in h.get_peer_info():
            src = int(p.source)
            for k in counts:
                if src & k:
                    counts[k] += 1
    except Exception:  # noqa: BLE001
        pass
    private = e.is_private
    flags = int(h.flags())
    for label, enabled, key, disable_flag in (
        ("DHT", dht_enabled, SRC_DHT, lt.torrent_flags.disable_dht),
        ("PeX", pex_enabled, SRC_PEX, lt.torrent_flags.disable_pex),
        ("LSD", lsd_enabled, SRC_LSD, lt.torrent_flags.disable_lsd),
    ):
        on = enabled and not private and not (flags & int(disable_flag))
        rows.append({
            "url": f"** [{label}] **", "tier": -1, "status": "working" if on else "disabled",
            "message": "" if on else ("This torrent is private" if private and enabled else ""),
            "peers": counts[key] if on else 0, "seeds": -1, "leeches": -1, "downloaded": -1,
            "nextAnnounce": 0, "minAnnounce": 0, "pseudo": True,
        })

    for t in h.trackers():
        statuses, messages = [], []
        seeds = leeches = downloaded = -1
        next_ann = min_ann = 0
        for ep in t.get("endpoints", []):
            ihs = ep.get("info_hashes", [])
            for idx, info in enumerate(ihs):
                if (idx == 0 and not use_v1) or (idx == 1 and not use_v2):
                    continue
                if info.get("updating"):
                    statuses.append("updating")
                elif info.get("fails", 0) == 0:
                    statuses.append("working" if info.get("start_sent") else "notContacted")
                else:
                    statuses.append("notWorking")
                msg = info.get("message") or error_text(info.get("last_error"))
                if msg:
                    messages.append(msg)
                seeds = max(seeds, info.get("scrape_complete", -1))
                leeches = max(leeches, info.get("scrape_incomplete", -1))
                downloaded = max(downloaded, info.get("scrape_downloaded", -1))
                na = int(info.get("next_announce") or 0)
                if na and (not next_ann or na < next_ann):
                    next_ann = na
                ma = int(info.get("min_announce") or 0)
                if ma and (not min_ann or ma < min_ann):
                    min_ann = ma
        if "working" in statuses:
            status = "working"
        elif "updating" in statuses:
            status = "updating"
        elif "notWorking" in statuses:
            status = "notWorking"
        else:
            status = "notContacted"
        rows.append({
            "url": t["url"],
            "tier": int(t.get("tier", 0)),
            "status": status,
            "message": "; ".join(dict.fromkeys(messages)),
            "peers": -1,
            "seeds": seeds,
            "leeches": leeches,
            "downloaded": downloaded,
            "nextAnnounce": max(0, int(next_ann - now)) if next_ann else 0,
            "minAnnounce": max(0, int(min_ann - now)) if min_ann else 0,
            "pseudo": False,
        })
    return rows


def pieces(e: Entry, buckets: int = 1024) -> dict[str, Any]:
    h = e.handle
    ti = h.torrent_file()
    if ti is None:
        return {"numPieces": 0, "pieceSize": 0, "have": [], "downloading": [], "availability": []}
    st = h.status(Q_PIECES)
    have = st.pieces
    n = len(have)
    if n == 0:
        return {"numPieces": 0, "pieceSize": ti.piece_length(), "piecesHave": 0, "have": [], "downloading": [], "availability": []}
    downloading = set()
    try:
        for q in h.get_download_queue():
            downloading.add(int(q["piece_index"]))
    except Exception:  # noqa: BLE001
        pass
    avail = h.piece_availability()
    buckets = max(1, min(buckets, n))
    have_out, dl_out, av_out = [], [], []
    for b in range(buckets):
        start = b * n // buckets
        end = max(start + 1, (b + 1) * n // buckets)
        seg = range(start, end)
        cnt = end - start
        have_out.append(round(sum(1 for i in seg if have[i]) / cnt, 3))
        dl_out.append(round(sum(1 for i in seg if i in downloading) / cnt, 3))
        if avail:
            av_out.append(round(sum(avail[start:end]) / cnt, 2))
    return {
        "numPieces": n,
        "pieceSize": ti.piece_length(),
        "piecesHave": st.num_pieces,
        "have": have_out,
        "downloading": dl_out,
        "availability": av_out,
    }


def web_seeds(e: Entry) -> list[str]:
    h = e.handle
    return sorted(set(h.url_seeds()) | set(h.http_seeds()))
