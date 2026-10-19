"""Torrent search compatible with qBittorrent's nova3 search plugins."""

from .manager import CATEGORIES, NotFoundError, SearchManager

__all__ = ["CATEGORIES", "NotFoundError", "SearchManager"]
