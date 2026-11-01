#!/usr/bin/env python3
"""Local Linux + live-OPDS overlays for the pinned CrossInk v1.6.1 checkout.

Never pushed to uxjulia/CrossInk. The v1.6.1 simulator env documents Apple
Silicon; on Linux GCC the same sources compile once -Wno-c++11-narrowing is
replaced by -Wno-narrowing. The same pin stubs OPDS fetch/download under
#ifdef SIMULATOR with fake books. This overlay keeps the Wi-Fi skip and
restores HttpDownloader so the UI talks to a real catalog.
"""
from __future__ import annotations

from pathlib import Path
import sys

MARKER = "CROSSINK_SIM_LIVE_OPDS"

LOCAL_INI = """\
; Written by scripts/crossink-sim/apply-overlays.py. Not part of CrossInk.
; GCC rejects -Wno-c++11-narrowing (Clang-only). Generated gzip HTML headers
; need -Wno-narrowing. OpenSSL is required by the Linux simulator HTTP shims.
[env:simulator-X3]
build_flags =
  ${simulator-base.build_flags}
  -DCROSSINK_APP_CAP_TOUCH=0
  -DCROSSINK_APP_CAP_USB_DRIVE=0
  -DCROSSINK_FIRMWARE_DEVICE_TYPE=\\"x3-x4\\"
  -DSIMULATOR_DEVICE_X3
  -Wno-narrowing
  -lssl
  -lcrypto
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
#endif
"""


def apply(root: Path) -> None:
    ini = root / "platformio.local.ini"
    if not ini.exists() or MARKER not in ini.read_text():
        ini.write_text(f"; {MARKER}\n{LOCAL_INI}")

    opds = root / "src/activities/browser/OpdsBookBrowserActivity.cpp"
    text = opds.read_text()
    if MARKER in text:
        print(f"overlays already applied under {root}", file=sys.stderr)
        return
    if FAKE_FEED not in text:
        raise SystemExit(f"fetch stub not found in {opds}")
    if FAKE_DOWNLOAD not in text:
        raise SystemExit(f"download stub not found in {opds}")
    text = text.replace(FAKE_FEED, LIVE_FEED, 1).replace(FAKE_DOWNLOAD, LIVE_DOWNLOAD, 1)
    opds.write_text(text)
    print(f"applied Linux flags + live OPDS overlay under {root}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-overlays.py <CrossInk-checkout>")
    apply(Path(sys.argv[1]).resolve())
