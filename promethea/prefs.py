"""User preferences: defaults, persistence, validation and libtorrent mapping."""

from __future__ import annotations

import copy
import hashlib
import hmac
import logging
import os
import random
import secrets
from pathlib import Path
from typing import Any

import libtorrent as lt

from .paths import default_download_dir
from .util import atomic_write_json, read_json

log = logging.getLogger("promethea.prefs")

DHT_BOOTSTRAP = ",".join(
    [
        "dht.libtorrent.org:25401",
        "router.bittorrent.com:6881",
        "router.utorrent.com:6881",
        "dht.transmissionbt.com:6881",
        "dht.aelitis.com:6881",
    ]
)

DEFAULT_SMART_FILTERS = [
    r"s(\d+)e(\d+)",
    r"(\d+)x(\d+)",
    r"(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})",
    r"(\d{1,2}[.\-]\d{1,2}[.\-]\d{4})",
]


def _cpu_count() -> int:
    return os.cpu_count() or 4


def _defaults() -> dict[str, Any]:
    save = str(default_download_dir())
    return {
        "behavior": {
            "theme": "system",  # system | dark | light
            "accent": "violet",
            "density": "comfortable",  # comfortable | compact
            "confirmDelete": True,
            "deleteFilesDefault": False,
            "useRecycleBin": True,
            "speedInTitle": True,
            "closeToTray": False,
            "minimizeToTray": False,
            "startMinimized": False,
            "notifyOnComplete": True,
            "notifyOnError": True,
            "preventSleep": True,
            "confirmExitWithActive": False,
            "showDetailsPanel": True,
        },
        "downloads": {
            "savePath": save,
            "useIncompletePath": False,
            "incompletePath": str(Path(save) / "Incomplete"),
            "appendExtension": False,
            "preallocate": False,
            "startPaused": False,
            "showAddDialog": True,
            "addToTop": False,
            "contentLayout": "original",  # original | subfolder | noSubfolder
            "stopCondition": "none",  # none | metadata | checked
            "deleteTorrentFile": False,
            "copyTorrentTo": "",
            "copyFinishedTorrentTo": "",
            "watchedFolders": [],  # [{path, savePath, category, paused}]
            "autoTMM": False,
            "excludedFileNames": "",
            "runOnAdded": "",
            "runOnFinished": "",
            "recheckOnCompletion": False,
        },
        "connection": {
            "port": random.randint(20000, 60000),
            "upnp": True,
            "protocol": "both",  # both | tcp | utp
            "maxConnections": 800,
            "maxConnectionsPerTorrent": 200,
            "maxUploads": 20,
            "maxUploadsPerTorrent": -1,
            "proxyType": "none",  # none | socks4 | socks5 | http
            "proxyHost": "",
            "proxyPort": 8080,
            "proxyAuth": False,
            "proxyUsername": "",
            "proxyPassword": "",
            "proxyPeers": True,
            "proxyHostnames": True,
            "ipFilterEnabled": False,
            "ipFilterPath": "",
            "ipFilterTrackers": False,
            "bannedIPs": [],
            "interface": "",
        },
        "speed": {
            "dlLimit": 0,  # bytes/s, 0 = unlimited
            "upLimit": 0,
            "altDlLimit": 2 * 1024 * 1024,
            "altUpLimit": 512 * 1024,
            "altEnabled": False,
            "scheduleEnabled": False,
            "scheduleFrom": "08:00",
            "scheduleTo": "20:00",
            "scheduleDays": "every",  # every | weekdays | weekends | mon..sun
            "limitUtp": True,
            "limitOverhead": False,
            "limitLan": False,
        },
        "bittorrent": {
            "dht": True,
            "pex": True,
            "lsd": True,
            "encryption": "prefer",  # prefer | require | disable
            "anonymousMode": False,
            "maxActiveChecking": 1,
            "queueing": True,
            "maxActiveDownloads": 5,
            "maxActiveUploads": 5,
            "maxActiveTorrents": 10,
            "dontCountSlow": True,
            "slowDlRate": 2,  # KiB/s
            "slowUpRate": 2,
            "slowInactivityTimer": 60,  # seconds
            "ratioLimitEnabled": False,
            "ratioLimit": 1.0,
            "seedingTimeLimitEnabled": False,
            "seedingTimeLimit": 1440,  # minutes
            "inactiveSeedingTimeLimitEnabled": False,
            "inactiveSeedingTimeLimit": 1440,
            "seedingLimitAction": "stop",  # stop | remove | removeWithFiles | superSeeding
            "addTrackersEnabled": False,
            "addTrackers": "",
        },
        "rss": {
            "fetchEnabled": True,
            "refreshInterval": 30,
            "maxArticles": 50,
            "autoDownload": False,
            "smartFilters": list(DEFAULT_SMART_FILTERS),
            "downloadRepacks": True,
        },
        "webui": {
            "enabled": False,
            "address": "0.0.0.0",
            "port": 8080,
            "username": "admin",
            "passwordHash": "",
            "bypassLocalhost": False,
            "sessionTimeout": 3600,
            "maxAuthFailures": 5,
            "banDuration": 3600,
            "https": False,
            "certPath": "",
            "keyPath": "",
        },
        "advanced": {
            "aioThreads": 10,
            "hashingThreads": max(2, min(8, _cpu_count() // 2)),
            "filePoolSize": 500,
            "checkingMemory": 64,  # MiB
            "diskQueueSize": 100,  # MiB
            "diskWriteMode": "auto",  # auto | pwrite | mmap
            "diskCacheMode": "default",  # default | enableOsCache | disableOsCache | writeThrough
            "sendBufferWatermark": 2048,  # KiB
            "sendBufferLowWatermark": 256,  # KiB
            "sendBufferWatermarkFactor": 150,  # %
            "requestQueueSize": 1500,
            "connectionSpeed": 100,  # outgoing connections per second
            "torrentConnectBoost": 50,
            "peerConnectTimeout": 7,
            "requestTimeout": 20,
            "socketBacklog": 128,
            "outgoingPortMin": 0,
            "outgoingPortMax": 0,
            "upnpLeaseDuration": 0,
            "peerDscp": 0,
            "mixedMode": "preferTcp",  # preferTcp | peerProportional
            "allowMultipleConnectionsPerIp": False,
            "validateHttpsTrackers": True,
            "ssrfMitigation": True,
            "blockPrivilegedPorts": False,
            "chokingAlgorithm": "fixedSlots",  # fixedSlots | rateBased
            "seedChokingAlgorithm": "fastestUpload",  # roundRobin | fastestUpload | antiLeech
            "announceToAllTrackers": True,
            "announceToAllTiers": True,
            "announceIp": "",
            "announcePort": 0,
            "maxConcurrentHttpAnnounces": 50,
            "stopTrackerTimeout": 2,
            "peerTurnover": 4,
            "peerTurnoverCutoff": 90,
            "peerTurnoverInterval": 300,
            "pieceExtentAffinity": True,
            "suggestMode": False,
            "maxPeerListSize": 4000,
            "dhtBootstrapNodes": DHT_BOOTSTRAP,
            "resumeSaveInterval": 5,  # minutes
            "uiRefreshInterval": 1000,  # ms
            "speedHistoryMinutes": 30,
        },
    }


# Settings only the desktop user (not a remote web UI user) may change, because
# they can execute programs or reveal the host's filesystem layout.
LOCAL_ONLY = {
    ("downloads", "runOnAdded"),
    ("downloads", "runOnFinished"),
    ("webui", "enabled"),
    ("webui", "address"),
    ("webui", "port"),
    ("webui", "bypassLocalhost"),
    ("webui", "https"),
    ("webui", "certPath"),
    ("webui", "keyPath"),
}

SECRET_KEYS = {("webui", "passwordHash"), ("connection", "proxyPassword")}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha512", password.encode("utf-8"), salt, 100_000)
    return f"pbkdf2-sha512${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, digest_hex = stored.split("$")
        if algo != "pbkdf2-sha512":
            return False
        digest = hashlib.pbkdf2_hmac("sha512", password.encode("utf-8"), bytes.fromhex(salt_hex), 100_000)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _coerce(value: Any, default: Any) -> Any:
    """Coerce an incoming value to the type of the default, or raise ValueError."""
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        raise ValueError("expected boolean")
    if isinstance(default, int):
        if isinstance(value, bool):
            raise ValueError("expected integer")
        if isinstance(value, (int, float)):
            return int(value)
        raise ValueError("expected integer")
    if isinstance(default, float):
        if isinstance(value, bool):
            raise ValueError("expected number")
        if isinstance(value, (int, float)):
            return float(value)
        raise ValueError("expected number")
    if isinstance(default, str):
        if isinstance(value, str):
            return value
        raise ValueError("expected string")
    if isinstance(default, list):
        if isinstance(value, list):
            return value
        raise ValueError("expected list")
    return value


class Prefs:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = _defaults()
        stored = read_json(path, {})
        if isinstance(stored, dict):
            for section, values in stored.items():
                if section in self.data and isinstance(values, dict):
                    for key, value in values.items():
                        if key in self.data[section]:
                            try:
                                self.data[section][key] = _coerce(value, self.data[section][key])
                            except ValueError:
                                log.warning("ignoring invalid stored pref %s.%s", section, key)
        if not stored:
            self.save()

    def __getitem__(self, section: str) -> dict[str, Any]:
        return self.data[section]

    def get(self, section: str, key: str) -> Any:
        return self.data[section][key]

    def save(self) -> None:
        atomic_write_json(self.path, self.data)

    def public(self) -> dict[str, Any]:
        """Prefs as sent to the UI (secrets removed)."""
        out = copy.deepcopy(self.data)
        out["webui"]["passwordSet"] = bool(out["webui"].pop("passwordHash"))
        out["connection"]["proxyPassword"] = "" if not out["connection"]["proxyPassword"] else "********"
        return out

    def update(self, patch: dict[str, Any], *, local: bool) -> set[tuple[str, str]]:
        """Validate and apply a partial update. Returns the changed (section, key) pairs."""
        changed: set[tuple[str, str]] = set()
        staged = copy.deepcopy(self.data)
        for section, values in patch.items():
            if section not in staged or not isinstance(values, dict):
                raise ValueError(f"unknown section {section!r}")
            for key, value in values.items():
                if section == "webui" and key == "password":
                    if not local:
                        raise ValueError("the web UI password can only be changed from the desktop app")
                    if value:
                        staged["webui"]["passwordHash"] = hash_password(str(value))
                        changed.add(("webui", "passwordHash"))
                    continue
                if (section, key) == ("webui", "passwordHash"):
                    raise ValueError("set webui.password instead")
                if key not in staged[section]:
                    raise ValueError(f"unknown setting {section}.{key}")
                if (section, key) in LOCAL_ONLY and not local:
                    raise ValueError(f"{section}.{key} can only be changed from the desktop app")
                if (section, key) == ("connection", "proxyPassword") and value == "********":
                    continue
                new = _coerce(value, staged[section][key])
                if new != staged[section][key]:
                    staged[section][key] = new
                    changed.add((section, key))
        _validate(staged)
        self.data = staged
        if changed:
            self.save()
        return changed


def _validate(d: dict[str, Any]) -> None:
    c = d["connection"]
    if not (1 <= c["port"] <= 65535):
        raise ValueError("listening port must be between 1 and 65535")
    if c["protocol"] not in ("both", "tcp", "utp"):
        raise ValueError("invalid protocol")
    if c["proxyType"] not in ("none", "socks4", "socks5", "http"):
        raise ValueError("invalid proxy type")
    if d["bittorrent"]["encryption"] not in ("prefer", "require", "disable"):
        raise ValueError("invalid encryption mode")
    if d["bittorrent"]["seedingLimitAction"] not in ("stop", "remove", "removeWithFiles", "superSeeding"):
        raise ValueError("invalid seeding limit action")
    if d["downloads"]["contentLayout"] not in ("original", "subfolder", "noSubfolder"):
        raise ValueError("invalid content layout")
    if d["downloads"]["stopCondition"] not in ("none", "metadata", "checked"):
        raise ValueError("invalid stop condition")
    if not (1 <= d["webui"]["port"] <= 65535):
        raise ValueError("web UI port must be between 1 and 65535")
    for key in ("dlLimit", "upLimit", "altDlLimit", "altUpLimit"):
        if d["speed"][key] < 0:
            raise ValueError("speed limits cannot be negative")
    if d["behavior"]["theme"] not in ("system", "dark", "light"):
        raise ValueError("invalid theme")


def _kib(v: int) -> int:
    return max(0, int(v)) * 1024


def lt_settings(p: Prefs, *, alt_speed: bool, fingerprint: str) -> dict[str, Any]:
    """Translate preferences into a libtorrent settings dict, tuned for throughput."""
    c, s, b, a = p["connection"], p["speed"], p["bittorrent"], p["advanced"]

    iface = c["interface"].strip()
    host = iface or "0.0.0.0"
    host6 = iface or "[::]"
    port = c["port"]
    listen = f"{host}:{port},{host6}:{port}" if not iface else f"{iface}:{port}"

    dl = s["altDlLimit"] if alt_speed else s["dlLimit"]
    ul = s["altUpLimit"] if alt_speed else s["upLimit"]

    enc = {"prefer": 1, "require": 2, "disable": 0}[b["encryption"]]  # pe_enabled / pe_forced / pe_disabled
    enc_level = 2 if b["encryption"] == "require" else 3  # rc4 / both

    proxy_type = 0
    if c["proxyType"] == "socks4":
        proxy_type = 1
    elif c["proxyType"] == "socks5":
        proxy_type = 3 if c["proxyAuth"] else 2
    elif c["proxyType"] == "http":
        proxy_type = 5 if c["proxyAuth"] else 4

    queueing = b["queueing"]
    write_mode = {"pwrite": "always_pwrite", "mmap": "always_mmap_write", "auto": "auto_mmap_write"}[a["diskWriteMode"]] \
        if a["diskWriteMode"] in ("pwrite", "mmap", "auto") else "auto_mmap_write"

    settings: dict[str, Any] = {
        "listen_interfaces": listen,
        "peer_fingerprint": fingerprint,
        "user_agent": "Promethea/0.1 libtorrent/" + lt.__version__,
        "alert_mask": int(
            lt.alert_category.error
            | lt.alert_category.status
            | lt.alert_category.storage
            | lt.alert_category.tracker
            | lt.alert_category.port_mapping
            | lt.alert_category.ip_block
            | lt.alert_category.performance_warning
            | lt.alert_category.file_progress
        ),
        "alert_queue_size": 20000,
        # discovery
        "enable_dht": b["dht"],
        "enable_lsd": b["lsd"],
        "enable_upnp": c["upnp"],
        "enable_natpmp": c["upnp"],
        "dht_bootstrap_nodes": a["dhtBootstrapNodes"],
        "anonymous_mode": b["anonymousMode"],
        # protocols
        "enable_outgoing_tcp": c["protocol"] in ("both", "tcp"),
        "enable_incoming_tcp": c["protocol"] in ("both", "tcp"),
        "enable_outgoing_utp": c["protocol"] in ("both", "utp"),
        "enable_incoming_utp": c["protocol"] in ("both", "utp"),
        "mixed_mode_algorithm": 0 if a["mixedMode"] == "preferTcp" else 1,
        "in_enc_policy": enc,
        "out_enc_policy": enc,
        "allowed_enc_level": enc_level,
        "prefer_rc4": b["encryption"] == "require",
        # rates
        "download_rate_limit": max(0, int(dl)),
        "upload_rate_limit": max(0, int(ul)),
        "rate_limit_utp": s["limitUtp"],
        "rate_limit_ip_overhead": s["limitOverhead"],
        "ignore_limits_on_local_network": not s["limitLan"],
        # connections
        "connections_limit": c["maxConnections"] if c["maxConnections"] > 0 else 16000,
        "unchoke_slots_limit": c["maxUploads"] if c["maxUploads"] > 0 else -1,
        "connection_speed": a["connectionSpeed"],
        "torrent_connect_boost": a["torrentConnectBoost"],
        "peer_connect_timeout": a["peerConnectTimeout"],
        "request_timeout": a["requestTimeout"],
        "listen_queue_size": a["socketBacklog"],
        "max_peerlist_size": a["maxPeerListSize"],
        "allow_multiple_connections_per_ip": a["allowMultipleConnectionsPerIp"],
        "no_connect_privileged_ports": a["blockPrivilegedPorts"],
        "ssrf_mitigation": a["ssrfMitigation"],
        "validate_https_trackers": a["validateHttpsTrackers"],
        "peer_dscp": a["peerDscp"],
        "outgoing_port": a["outgoingPortMin"],
        "num_outgoing_ports": max(0, a["outgoingPortMax"] - a["outgoingPortMin"]) if a["outgoingPortMin"] else 0,
        "upnp_lease_duration": a["upnpLeaseDuration"],
        "natpmp_lease_duration": a["upnpLeaseDuration"],
        "peer_turnover": a["peerTurnover"],
        "peer_turnover_cutoff": a["peerTurnoverCutoff"],
        "peer_turnover_interval": a["peerTurnoverInterval"],
        # choking
        "choking_algorithm": 0 if a["chokingAlgorithm"] == "fixedSlots" else 2,
        "seed_choking_algorithm": {"roundRobin": 0, "fastestUpload": 1, "antiLeech": 2}.get(a["seedChokingAlgorithm"], 1),
        # request pipeline and buffers (throughput)
        "max_out_request_queue": a["requestQueueSize"],
        "max_allowed_in_request_queue": 2000,
        "max_peer_recv_buffer_size": 5 * 1024 * 1024,
        "send_buffer_watermark": _kib(a["sendBufferWatermark"]),
        "send_buffer_low_watermark": _kib(a["sendBufferLowWatermark"]),
        "send_buffer_watermark_factor": a["sendBufferWatermarkFactor"],
        "send_not_sent_low_watermark": 512 * 1024,
        "piece_extent_affinity": a["pieceExtentAffinity"],
        "suggest_mode": 1 if a["suggestMode"] else 0,
        # disk
        "aio_threads": max(1, a["aioThreads"]),
        "hashing_threads": max(1, a["hashingThreads"]),
        "file_pool_size": max(10, a["filePoolSize"]),
        "checking_mem_usage": max(16, a["checkingMemory"] * 64),
        "max_queued_disk_bytes": max(1, a["diskQueueSize"]) * 1024 * 1024,
        "disk_write_mode": int(lt.mmap_write_mode_t.names[write_mode]),
        "active_checking": max(1, b["maxActiveChecking"]),
        # trackers
        "announce_to_all_trackers": a["announceToAllTrackers"],
        "announce_to_all_tiers": a["announceToAllTiers"],
        "announce_ip": a["announceIp"],
        "announce_port": a["announcePort"],
        "max_concurrent_http_announces": a["maxConcurrentHttpAnnounces"],
        "stop_tracker_timeout": a["stopTrackerTimeout"],
        "apply_ip_filter_to_trackers": c["ipFilterTrackers"],
        # queueing (-1 = unlimited)
        "active_downloads": b["maxActiveDownloads"] if queueing else -1,
        "active_seeds": b["maxActiveUploads"] if queueing else -1,
        "active_limit": b["maxActiveTorrents"] if queueing else -1,
        "dont_count_slow_torrents": b["dontCountSlow"],
        "inactive_down_rate": _kib(b["slowDlRate"]),
        "inactive_up_rate": _kib(b["slowUpRate"]),
        "auto_manage_startup": b["slowInactivityTimer"],
        "active_tracker_limit": -1,
        "active_dht_limit": -1,
        "active_lsd_limit": -1,
        # proxy
        "proxy_type": proxy_type,
        "proxy_hostname": c["proxyHost"],
        "proxy_port": c["proxyPort"],
        "proxy_username": c["proxyUsername"] if c["proxyAuth"] else "",
        "proxy_password": c["proxyPassword"] if c["proxyAuth"] else "",
        "proxy_peer_connections": c["proxyPeers"],
        "proxy_tracker_connections": True,
        "proxy_hostnames": c["proxyHostnames"],
    }
    cache_mode = a["diskCacheMode"]
    if cache_mode != "default":
        mode = {
            "enableOsCache": "enable_os_cache",
            "disableOsCache": "disable_os_cache",
            "writeThrough": "write_through",
        }.get(cache_mode)
        if mode:
            settings["disk_io_read_mode"] = int(lt.io_buffer_mode_t.names[mode])
            settings["disk_io_write_mode"] = int(lt.io_buffer_mode_t.names[mode])
    return settings
