"""Write the license texts of everything the packaged app bundles to build/THIRD-PARTY-NOTICES.txt.

usage: python packaging/notices.py
"""

import sys
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD_TOOLS = {"promethea", "pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "pefile", "pywin32-ctypes",
               "setuptools", "pip", "packaging"}


def license_texts(dist: metadata.Distribution) -> list[str]:
    texts = []
    for f in dist.files or []:
        name = f.name.upper()
        if any(k in name for k in ("LICENSE", "LICENCE", "COPYING", "NOTICE")) and not name.endswith(".PY"):
            try:
                texts.append(Path(dist.locate_file(f)).read_text(encoding="utf-8", errors="replace").strip())
            except OSError:
                pass
    return texts


def main() -> None:
    out = ["Promethea bundles the following software. Their licenses follow.", ""]
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    sections = [("Python " + sys.version.split()[0], [python_license.read_text(encoding="utf-8")]
                 if python_license.exists() else ["Python Software Foundation License"])]
    for dist in sorted(metadata.distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        if name.lower() in BUILD_TOOLS:
            continue
        texts = license_texts(dist) or [dist.metadata.get("License-Expression") or dist.metadata.get("License") or
                                        "See " + (dist.metadata.get("Home-page") or "the project's page")]
        sections.append((f"{name} {dist.version}", texts))
    sections.append(("Microsoft Edge WebView2 (WebView2Loader.dll and the .NET WebView2 libraries, via pywebview)",
                     ["Redistributed under the Microsoft WebView2 SDK license: "
                      "https://www.nuget.org/packages/Microsoft.Web.WebView2/License"]))
    for title, texts in sections:
        out += ["=" * 78, title, "=" * 78, "", *("\n\n".join(texts).splitlines()), ""]
    target = ROOT / "build" / "THIRD-PARTY-NOTICES.txt"
    target.parent.mkdir(exist_ok=True)
    target.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {target} ({len(sections)} components)")


if __name__ == "__main__":
    main()
