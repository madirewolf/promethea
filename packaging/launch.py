"""Entry point of the packaged (PyInstaller) Promethea."""

import contextlib
import multiprocessing
import os
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()  # the torrent creator's hashing process starts here
    if sys.argv[1:2] == ["--search-runner"]:
        # One search plugin, run with the bundled Python (promethea/search/manager.py starts these).
        from promethea.search.nova import runner

        code = runner.main(sys.argv[2:])
        for stream in (sys.stdout, sys.stderr):
            with contextlib.suppress(Exception):
                stream.flush()
        os._exit(code)  # like runner.py: plugins sometimes leave non-daemon threads behind
    from promethea.app import main

    sys.exit(main())
