#!/usr/bin/env python3
"""Local Linux + live-OPDS overlays for the pinned CrossInk v1.6.1 checkout.

Never pushed to uxjulia/CrossInk. Merges into platformio.local.ini (does not
replace an existing unmarked file). Verifies the result: fake OPDS stubs must
be gone, X3 flags must be present, and the clang-only warning flag must be
removed via build_unflags. libcrypto is for the simulator MD5 builder; the
HTTP path is host curl.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys

MARKER = "CROSSINK_SIM_LIVE_OPDS"
SIMULATOR_SHA = "27655f1d36ef5f8610fedd798d5564d04c8f4320"
SIMULATOR_DEP = f"simulator=https://github.com/uxjulia/crossink-simulator.git#{SIMULATOR_SHA}"

X3_SECTION = f"""\
; {MARKER}
[env:simulator-X3]
build_unflags = -Wno-c++11-narrowing
build_flags =
  ${{simulator-base.build_flags}}
  -DCROSSINK_APP_CAP_TOUCH=0
  -DCROSSINK_APP_CAP_USB_DRIVE=0
  -DCROSSINK_FIRMWARE_DEVICE_TYPE=\\"x3-x4\\"
  -DSIMULATOR_DEVICE_X3
  -Wno-narrowing
  -lssl
  -lcrypto
lib_deps =
  {SIMULATOR_DEP}
  FreeInkUI=symlink://freeink-sdk/libs/ui/FreeInkUI
  Icons=symlink://freeink-sdk/libs/assets/Icons
  NearbyTransfer=symlink://freeink-sdk/libs/network/NearbyTransfer
  bblanchon/ArduinoJson @ 7.4.2
  ricmoo/QRCode @ ^0.0.1
  bitbank2/PNGdec @ 1.1.6
  https://github.com/bitbank2/JPEGDEC.git#86282979224c8a32fd51e091ed5a35b0c699a52b
  links2004/WebSockets @ 2.7.3
"""

FAKE_FEED = """\
#ifdef SIMULATOR
  clearEntries();
  searchTemplate = "simulator://search?query={searchTerms}";

  if (path.empty()) {
    appendEntry(OpdsEntry{OpdsEntryType::NAVIGATION, "Browse fiction", "", "/fiction", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "The Left Hand of Darkness", "Ursula K. Le Guin",
                          "/books/the-left-hand-of-darkness.epub", ""});
    appendEntry(
        OpdsEntry{OpdsEntryType::BOOK, "A Room of One's Own", "Virginia Woolf", "/books/a-room-of-ones-own.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "Frankenstein", "Mary Shelley", "/books/frankenstein.epub", ""});
  } else {
    appendEntry(
        OpdsEntry{OpdsEntryType::BOOK, "The Dispossessed", "Ursula K. Le Guin", "/books/the-dispossessed.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "Kindred", "Octavia E. Butler", "/books/kindred.epub", ""});
    appendEntry(OpdsEntry{OpdsEntryType::BOOK, "The Time Machine", "H. G. Wells", "/books/the-time-machine.epub", ""});
  }

  selectorIndex = 0;
  topIndex = 0;
  state = BrowserState::BROWSING;
  requestUpdate();
  return;
#endif
"""

LIVE_FEED = f"""\
#ifdef SIMULATOR
  // {MARKER}: use the real feed path against the seeded OPDS server.
#endif
"""

FAKE_DOWNLOAD = """\
#ifdef SIMULATOR
  downloadProgress = 1;
  downloadTotal = 2;
  requestUpdate(true);
  return;
#endif
"""

LIVE_DOWNLOAD = f"""\
#ifdef SIMULATOR
  // {MARKER}: fall through to HttpDownloader::downloadToFile.
  // curl blocks the SDL thread, so paint + capture 04-download first.
  requestUpdateAndWait();
  LOG_INF("OPDS", "Downloading screen presented");
  extern void crossinkSimWaitControlShot(unsigned);
  crossinkSimWaitControlShot(4000);
#endif
"""


def _section_span(text: str, name: str) -> tuple[int, int] | None:
    match = re.search(rf"(?ms)^\[{re.escape(name)}\][^\[]*", text)
    return (match.start(), match.end()) if match else None


def _user_keys(section_body: str) -> tuple[list[str], list[str]]:
    ours = {"build_unflags", "build_flags", "lib_deps"}
    kept: list[str] = []
    extra_flags: list[str] = []
    in_flags = False
    in_ours = False
    for line in section_body.splitlines():
        if line.startswith("[") or line.startswith(";"):
            continue
        if line.strip() and not line.startswith((" ", "\t")) and "=" in line:
            key = line.split("=", 1)[0].strip()
            in_flags = key == "build_flags"
            in_ours = key in ours
            if not in_ours:
                kept.append(line.rstrip())
            continue
        if line.startswith((" ", "\t")) and line.strip():
            if in_flags and line.strip().startswith("-D") and "SIMULATOR_DEVICE_X3" not in line:
                extra_flags.append(line.rstrip())
            elif not in_ours:
                kept.append(line.rstrip())
    return kept, extra_flags


def merge_ini(root: Path) -> Path:
    ini = root / "platformio.local.ini"
    existing = ini.read_text() if ini.exists() else ""
    span = _section_span(existing, "env:simulator-X3")
    extras: list[str] = []
    extra_flags: list[str] = []
    prefix = existing
    if span:
        extras, extra_flags = _user_keys(existing[span[0] : span[1]])
        prefix = (existing[: span[0]] + existing[span[1] :]).strip()
    header = (
        f"; {MARKER}  GCC: drop -Wno-c++11-narrowing via build_unflags.\n"
        "; libcrypto is MD5Builder, not the curl HTTP shim.\n"
    )
    section = X3_SECTION
    if extra_flags:
        section = section.replace("  -lcrypto\n", "  -lcrypto\n" + "\n".join(extra_flags) + "\n", 1)
    body = (prefix + "\n\n" if prefix.strip() else "") + header + section
    if extras:
        body = body.rstrip() + "\n" + "\n".join(extras) + "\n"
    ini.write_text(body if body.endswith("\n") else body + "\n")
    return ini


def verify(root: Path, opds_text: str, ini_text: str) -> None:
    if FAKE_FEED in opds_text:
        raise SystemExit(f"fetch stub still present in {root}/src/activities/browser/OpdsBookBrowserActivity.cpp")
    if FAKE_DOWNLOAD in opds_text:
        raise SystemExit(f"download stub still present in {root}/src/activities/browser/OpdsBookBrowserActivity.cpp")
    if "Browse fiction" in opds_text:
        raise SystemExit("fake catalog title still present after overlay")
    if "downloadProgress = 1" in opds_text:
        raise SystemExit("fake download progress stub still present after overlay")
    if MARKER not in opds_text:
        raise SystemExit("live-OPDS marker missing from OpdsBookBrowserActivity.cpp")
    live_download = re.search(
        r"#ifdef SIMULATOR\n  // CROSSINK_SIM_LIVE_OPDS: fall through.*?#endif",
        opds_text,
        re.S,
    )
    if not live_download or "return;" in live_download.group(0):
        raise SystemExit("download overlay still returns before HttpDownloader")
    if "Downloading screen presented" not in opds_text or "crossinkSimWaitControlShot" not in opds_text:
        raise SystemExit("download overlay must present the Downloading screen before curl")
    if "-DSIMULATOR_DEVICE_X3" not in ini_text:
        raise SystemExit("platformio.local.ini lost -DSIMULATOR_DEVICE_X3")
    if "build_unflags = -Wno-c++11-narrowing" not in ini_text:
        raise SystemExit("platformio.local.ini must unflag -Wno-c++11-narrowing")
    if SIMULATOR_SHA not in ini_text:
        raise SystemExit("platformio.local.ini must pin crossink-simulator")
    if "-lssl" not in ini_text or "-lcrypto" not in ini_text:
        raise SystemExit("platformio.local.ini must link OpenSSL for MD5Builder")


def apply(root: Path) -> None:
    ini = merge_ini(root)
    opds = root / "src/activities/browser/OpdsBookBrowserActivity.cpp"
    text = opds.read_text()
    if FAKE_FEED in text:
        text = text.replace(FAKE_FEED, LIVE_FEED, 1)
    if FAKE_DOWNLOAD in text:
        text = text.replace(FAKE_DOWNLOAD, LIVE_DOWNLOAD, 1)
    if FAKE_FEED in text or FAKE_DOWNLOAD in text:
        raise SystemExit("failed to replace simulator OPDS stubs")
    if MARKER not in text:
        raise SystemExit(
            f"overlay marker missing and stubs not found in {opds}; "
            "reset the CrossInk cache to the pin"
        )
    opds.write_text(text)
    verify(root, text, ini.read_text())
    print(f"applied and verified Linux flags + live OPDS overlay under {root}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-overlays.py <CrossInk-checkout>")
    apply(Path(sys.argv[1]).resolve())
