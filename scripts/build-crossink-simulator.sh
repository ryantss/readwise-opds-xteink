#!/usr/bin/env bash
# Builds CrossInk v1.6.1's official PlatformIO native SDL simulator for the
# X3 panel (env:simulator-X3) on Linux. Applies a local overlay so OPDS fetch
# and download use HttpDownloader instead of the pin's fake catalog.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cache="$here/../.cache/crossink"
crossink_tag=v1.6.1
crossink_sha=9914146eeae7b46b300f475a16c32426fc02ec1f
export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"

checkout() {
  local repo=$1 dir=$2 sha=$3
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then return; fi
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$repo" 2>/dev/null || true
  git -C "$dir" fetch -q --depth 1 origin "$sha"
  git -C "$dir" checkout -q FETCH_HEAD
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is required ($2)" >&2
    exit 1
  fi
}

if ! command -v pio >/dev/null 2>&1; then
  python3 -m pip install --user -q platformio
fi
need_cmd pio "pip install --user platformio"
need_cmd sdl2-config "Debian/Ubuntu: sudo apt install libsdl2-dev"
need_cmd curl "used by the simulator HTTP shim"
pkg-config --exists libssl || {
  echo "error: OpenSSL headers required (Debian/Ubuntu: sudo apt install libssl-dev)" >&2
  exit 1
}

checkout https://github.com/uxjulia/CrossInk.git "$cache/CrossInk" "$crossink_sha"
ck="$cache/CrossInk"
if [ "$(git -C "$ck" rev-parse HEAD)" != "$crossink_sha" ]; then
  echo "error: CrossInk HEAD is $(git -C "$ck" rev-parse HEAD), expected $crossink_sha ($crossink_tag)" >&2
  exit 1
fi

git -C "$ck" submodule update --init --depth 1 freeink-sdk
if [ ! -f "$ck/freeink-sdk/libs/ui/FreeInkUI/library.json" ]; then
  echo "error: freeink-sdk submodule missing under $ck/freeink-sdk" >&2
  exit 1
fi
if [ ! -f "$cache/freeink-sdk/libs/network/SecureNet/include/SecureHttpClient.h" ]; then
  ln -sfn "$ck/freeink-sdk" "$cache/freeink-sdk"
fi

python3 "$here/crossink-sim/apply-overlays.py" "$ck"

# extra_configs = platformio.local.ini is required even when empty.
test -f "$ck/platformio.local.ini" || printf '%s\n' "; local overlay" > "$ck/platformio.local.ini"

echo "building CrossInk $crossink_tag $crossink_sha env:simulator-X3" >&2
(
  cd "$ck"
  pio run -e simulator-X3 -j"$(nproc)"
)

bin="$ck/.pio/build/simulator-X3/program"
if [ ! -x "$bin" ]; then
  echo "error: expected simulator binary at $bin" >&2
  exit 1
fi
echo "CrossInk $crossink_tag $crossink_sha simulator-X3" >&2
echo "$bin"
