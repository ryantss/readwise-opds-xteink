#!/usr/bin/env bash
# Builds the host CrossInk v1.6.1 device harness: real firmware HTTP/OPDS/zip
# sources plus FatFs-backed storage and a POSIX WiFiClient under wolfSSL 5.7.2.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cache="$here/../.cache/crossink"
crossink_tag=v1.6.1
crossink_sha=9914146eeae7b46b300f475a16c32426fc02ec1f
wolfssl_tag=v5.7.2-stable

# shellcheck source=crossink-sim/checkout-crossink.sh
. "$here/crossink-sim/checkout-crossink.sh"

checkout_crossink https://github.com/uxjulia/CrossInk.git "$cache/CrossInk" "$crossink_sha"
ck=$cache/CrossInk

# freeink-sdk is a CrossInk sibling checkout used for SecureHttpClient / SecureClient.
if [ ! -f "$cache/freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h" ]; then
  echo "error: freeink-sdk SecureNet is missing under $cache/freeink-sdk" >&2
  exit 1
fi
sdk=$cache/freeink-sdk

# FatFs (ChaN) — fetched once, then compiled with UTF-8 LFN + mkfs.
if [ ! -f "$cache/fatfs/source/ff.c" ]; then
  mkdir -p "$cache/fatfs"
  curl -fsSL -o /tmp/fatfs.tgz https://github.com/abbrev/fatfs/archive/refs/heads/master.tar.gz
  python3 - "$cache/fatfs" <<'PY'
import sys, tarfile, os, shutil
from pathlib import Path
dest = Path(sys.argv[1])
with tarfile.open("/tmp/fatfs.tgz") as t:
    t.extractall("/tmp/fatfs-extract")
found = None
for root, _, files in os.walk("/tmp/fatfs-extract"):
    if "ff.c" in files:
        found = Path(root)
        break
if not found:
    raise SystemExit("ff.c not found in FatFs archive")
out = dest / "source"
out.mkdir(parents=True, exist_ok=True)
for name in ["ff.c", "ff.h", "ffunicode.c", "ffsystem.c", "diskio.h", "ffconf.h"]:
    src = found / name
    if src.exists():
        shutil.copy2(src, out / name)
PY
fi

# Patch FatFs for UTF-8 LFN (SdFat-like) and mkfs. The checkout is cache-only.
python3 - "$cache/fatfs/source/ffconf.h" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
if "#define FF_USE_MKFS		1" in text and "#define FF_USE_LFN		3" in text:
    raise SystemExit(0)
repls = {
    "#define FF_USE_MKFS		0": "#define FF_USE_MKFS		1",
    "#define FF_CODE_PAGE	932": "#define FF_CODE_PAGE	437",
    "#define FF_USE_LFN		0": "#define FF_USE_LFN		3",
    "#define FF_LFN_UNICODE	0": "#define FF_LFN_UNICODE	2",
    "#define FF_FS_NORTC		0": "#define FF_FS_NORTC		1",
}
for old, new in repls.items():
    if old not in text:
        raise SystemExit(f"ffconf.h missing expected line: {old}")
    text = text.replace(old, new, 1)
p.write_text(text)
PY

# wolfSSL 5.7.2 — same major/minor as CrossInk's Arduino-wolfSSL @ 5.7.2.
if [ ! -f "$cache/wolfssl/lib/libwolfssl.a" ]; then
  if [ ! -d "$cache/wolfssl-src/.git" ]; then
    git clone --depth 1 --branch "$wolfssl_tag" https://github.com/wolfSSL/wolfssl.git "$cache/wolfssl-src"
  fi
  if [ ! -f "$cache/wolfssl-src/configure" ]; then
    (cd "$cache/wolfssl-src" && ./autogen.sh)
  fi
  (cd "$cache/wolfssl-src" && ./configure --prefix="$cache/wolfssl" --disable-shared --enable-static \
      --enable-tls13 --enable-sni --enable-maxfragment --enable-curve25519 \
      --disable-examples --disable-crypttests)
  make -C "$cache/wolfssl-src" -j"$(nproc)"
  make -C "$cache/wolfssl-src" install
fi

if clang++ -std=c++20 -xc++ - -o /dev/null >/dev/null 2>&1 <<'EOF'
#include <cstddef>
int main() { return 0; }
EOF
then
  cxx=(clang++ -std=c++20 -O1 -w)
  cc=(clang -O1 -w)
else
  cxx=(g++ -std=c++20 -O1 -w)
  cc=(gcc -O1 -w)
fi

mkdir -p "$cache/bin" "$cache/obj/device"
stubs=$here/crossink-device/stubs
inc=(
  -I "$stubs"
  -I "$cache/fatfs"
  -I "$cache/fatfs/source"
  -I "$cache/wolfssl/include"
  -I "$sdk/libs/network/SecureNet/include"
  -I "$ck/src"
  -I "$ck/lib/OpdsParser"
  -I "$ck/lib/XmlParserUtils"
  -I "$ck/lib/Utf8"
  -I "$ck/lib/Memory"
  -I "$ck/lib/ZipFile"
  -I "$ck/lib/AppVersion"
  -I "$ck/lib/hal"
)

"${cc[@]}" "${inc[@]}" -c "$cache/fatfs/source/ff.c" -o "$cache/obj/device/ff.o"
"${cc[@]}" "${inc[@]}" -c "$cache/fatfs/source/ffunicode.c" -o "$cache/obj/device/ffunicode.o"
"${cc[@]}" "${inc[@]}" -c "$cache/fatfs/source/ffsystem.c" -o "$cache/obj/device/ffsystem.o"
"${cc[@]}" "${inc[@]}" -c "$stubs/diskio.c" -o "$cache/obj/device/diskio.o"

defs=(
  -DFREEINK_NET_WOLFSSL=1
  -DHAVE_SNI
  -DHAVE_MAX_FRAGMENT
  -DHAVE_CURVE25519
  -DWOLFSSL_TLS13
  -DCROSSINK_VERSION=\"1.6.1\"
  -DCROSSINK_GIT_SHA=\"$crossink_sha\"
  -DCROSSINK_GIT_DIRTY=\"clean\"
)

"${cxx[@]}" "${defs[@]}" "${inc[@]}" -include wolfssl/options.h \
  "$here/crossink-device/device-harness.cpp" \
  "$here/crossink-device/stubs/WiFiClient.cpp" \
  "$here/crossink-device/stubs/HalStorage.cpp" \
  "$ck/src/network/HttpDownloader.cpp" \
  "$ck/src/util/UrlUtils.cpp" \
  "$ck/src/util/StringUtils.cpp" \
  "$ck/src/util/BuildInfo.cpp" \
  "$ck/lib/Utf8/Utf8.cpp" \
  "$ck/lib/OpdsParser/OpdsParser.cpp" \
  "$ck/lib/OpdsParser/OpdsStream.cpp" \
  "$ck/lib/ZipFile/ZipFile.cpp" \
  "$sdk/libs/network/SecureNet/src/SecureClient.cpp" \
  "$cache/obj/device/ff.o" \
  "$cache/obj/device/ffunicode.o" \
  "$cache/obj/device/ffsystem.o" \
  "$cache/obj/device/diskio.o" \
  -L "$cache/wolfssl/lib" -lwolfssl -lpthread -lexpat \
  -o "$cache/bin/crossink-device-harness"

echo "CrossInk $crossink_tag $crossink_sha + wolfSSL $wolfssl_tag + FatFs" >&2
echo "$cache/bin/crossink-device-harness"
