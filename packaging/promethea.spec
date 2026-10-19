# PyInstaller spec for Promethea. Build with packaging\build.ps1, or:
#   .venv\Scripts\python.exe -m PyInstaller packaging\promethea.spec --noconfirm
import importlib.util
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
)

ROOT = Path(SPECPATH).parent
sys.path.insert(0, str(ROOT))
from promethea import __version__  # noqa: E402

# Search plugins are third-party scripts that may import any part of the standard library,
# so bundle all of it, not just what Promethea itself imports.
SKIP = {"tkinter", "turtle", "turtledemo", "idlelib", "test", "ensurepip", "venv", "pydoc_data", "lib2to3"}
stdlib: list[str] = []
for name in sorted(sys.stdlib_module_names):
    if name.startswith("_") or name in SKIP:
        continue
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        continue
    if spec is None:
        continue
    if spec.submodule_search_locations:
        stdlib += collect_submodules(name, filter=lambda m: ".test" not in m and "idle" not in m)
    else:
        stdlib.append(name)

datas = collect_data_files("promethea", includes=["web/**/*", "assets/*"])
# The plugin runner puts its own folder on sys.path for plugins' `helpers` and `novaprinter`.
datas += [(str(ROOT / "promethea" / "search" / "nova" / f), "promethea/search/nova")
          for f in ("helpers.py", "novaprinter.py", "runner.py", "__init__.py")]

a = Analysis(
    [str(ROOT / "packaging" / "launch.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=stdlib + ["pystray._win32", "promethea.search.nova.runner"],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

nums = tuple(int(x) for x in __version__.split(".")) + (0,) * (4 - len(__version__.split(".")))
version = VSVersionInfo(
    ffi=FixedFileInfo(filevers=nums, prodvers=nums),
    kids=[
        StringFileInfo([StringTable("040904B0", [
            StringStruct("CompanyName", "Promethea"),
            StringStruct("FileDescription", "Promethea"),
            StringStruct("FileVersion", __version__),
            StringStruct("InternalName", "Promethea"),
            StringStruct("LegalCopyright", "GPL-3.0-or-later"),
            StringStruct("OriginalFilename", "Promethea.exe"),
            StringStruct("ProductName", "Promethea"),
            StringStruct("ProductVersion", __version__),
        ])]),
        VarFileInfo([VarStruct("Translation", [1033, 1200])]),
    ],
)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Promethea",
    icon=str(ROOT / "promethea" / "assets" / "promethea.ico"),
    version=version,
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Promethea", upx=False)
