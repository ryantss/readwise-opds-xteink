#!/usr/bin/env bash
# Builds CrossInk v1.6.1's official PlatformIO native SDL simulator for the
# X3 panel (env:simulator-X3) on Linux. Applies a local overlay so OPDS fetch
# and download use HttpDownloader instead of the pin's fake catalog.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cache="$here/../.cache/crossink"
crossink_tag=v1.6.1
crossink_sha=9914146eeae7b46b300f475a16c32426fc02ec1f
pio_version=6.2.0
export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"

# shellcheck source=crossink-sim/checkout-crossink.sh
. "$here/crossink-sim/checkout-crossink.sh"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is required ($2)" >&2
    exit 1
  fi
}

ensure_pio() {
  if command -v pio >/dev/null 2>&1; then
    local ver
    ver=$(pio --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    if [ "$ver" = "$pio_version" ]; then
      return
    fi
  fi
  python3 -m pip install --user -q "platformio==${pio_version}"
}

ensure_pio
need_cmd pio "pip install --user platformio==${pio_version}"
need_cmd sdl2-config "Debian/Ubuntu: sudo apt install libsdl2-dev"
need_cmd curl "used by the simulator HTTP shim"
pkg-config --exists libssl || {
  echo "error: OpenSSL headers required (Debian/Ubuntu: sudo apt install libssl-dev)" >&2
  exit 1
}

checkout_crossink https://github.com/uxjulia/CrossInk.git "$cache/CrossInk" "$crossink_sha"
ck="$cache/CrossInk"

git -C "$ck" submodule update --init --depth 1 freeink-sdk
if [ ! -f "$ck/freeink-sdk/libs/ui/FreeInkUI/library.json" ]; then
  echo "error: freeink-sdk submodule missing under $ck/freeink-sdk" >&2
  exit 1
fi
if [ ! -f "$cache/freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h" ]; then
  ln -sfn "$ck/freeink-sdk" "$cache/freeink-sdk"
fi

python3 "$here/crossink-sim/apply-overlays.py" "$ck"
test -f "$ck/platformio.local.ini" || printf '%s\n' "; local overlay" > "$ck/platformio.local.ini"

echo "building CrossInk $crossink_tag $crossink_sha env:simulator-X3 (PlatformIO $pio_version)" >&2
(
  cd "$ck"
  pio pkg install -e simulator-X3
  simlib=".pio/libdeps/simulator-X3/simulator"
  if [ ! -f "$simlib/src/HalGPIO.cpp" ]; then
    echo "error: crossink-simulator missing under $simlib" >&2
    exit 1
  fi
  python3 "$here/crossink-sim/apply-sim-control.py" "$simlib"
  pio run -e simulator-X3 -j"$(nproc)"
) >&2

bin="$ck/.pio/build/simulator-X3/program"
if [ ! -x "$bin" ]; then
  echo "error: expected simulator binary at $bin" >&2
  exit 1
fi
echo "CrossInk $crossink_tag $crossink_sha simulator-X3" >&2
echo "$bin"
