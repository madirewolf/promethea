import multiprocessing

from .app import main

if __name__ == "__main__":
    # A frozen build starts its torrent-creator child process through here.
    multiprocessing.freeze_support()
    raise SystemExit(main())
