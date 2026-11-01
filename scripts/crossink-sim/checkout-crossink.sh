# Shared pin checkout: always reset --hard and clean so a dirty cache cannot
# survive just because HEAD already matches. Source from the build scripts.
checkout_crossink() {
  local repo=$1 dir=$2 sha=$3
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$repo" 2>/dev/null || true
  fi
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" != "$sha" ]; then
    git -C "$dir" remote add origin "$repo" 2>/dev/null || true
    git -C "$dir" fetch -q --depth 1 origin "$sha"
    git -C "$dir" checkout -q --force FETCH_HEAD
  fi
  git -C "$dir" reset --hard HEAD
  # Keep .pio (object cache) and a user platformio.local.ini (merged, not replaced).
  git -C "$dir" clean -fd -e .pio -e platformio.local.ini
  if [ "$(git -C "$dir" rev-parse HEAD)" != "$sha" ]; then
    echo "error: CrossInk HEAD is $(git -C "$dir" rev-parse HEAD), expected $sha" >&2
    exit 1
  fi
}
