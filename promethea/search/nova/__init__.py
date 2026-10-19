"""nova3-compatible runtime for qBittorrent search plugins.

``helpers.py`` and ``novaprinter.py`` are importable as top-level modules inside
the plugin subprocess (``runner.py`` puts this directory on ``sys.path``), so
plugins written for qBittorrent can keep doing ``from helpers import ...`` and
``from novaprinter import prettyPrinter``.
"""
