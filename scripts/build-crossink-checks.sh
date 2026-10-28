#!/usr/bin/env bash
# Builds host binaries around CrossInk's own OPDS and OPF parsers, pinned to
# the v1.6.1 release (what an X3 on the default PlatformIO env can run).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cache="$here/../.cache/crossink"
# Tag v1.6.1 — pin by commit, not a moving branch.
crossink_tag=v1.6.1
crossink_sha=9914146eeae7b46b300f475a16c32426fc02ec1f

checkout() {
  local repo=$1 dir=$2 sha=$3
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then return; fi
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$repo" 2>/dev/null || true
  git -C "$dir" fetch -q --depth 1 origin "$sha"
  git -C "$dir" checkout -q FETCH_HEAD
}

checkout https://github.com/uxjulia/CrossInk.git "$cache/CrossInk" "$crossink_sha"

ck=$cache/CrossInk
if [ "$(git -C "$ck" rev-parse HEAD)" != "$crossink_sha" ]; then
  echo "error: CrossInk HEAD is $(git -C "$ck" rev-parse HEAD), expected $crossink_sha ($crossink_tag)" >&2
  exit 1
fi

mkdir -p "$cache/bin"
if clang++ -std=c++20 -xc++ - -o /dev/null >/dev/null 2>&1 <<'EOF'
#include <cstddef>
int main() { return 0; }
EOF
then
  cxx=(clang++ -std=c++20 -O1 -w)
else
  cxx=(g++ -std=c++20 -O1 -w)
fi

"${cxx[@]}" -I "$here/crosspoint/stubs" -I "$ck/lib/OpdsParser" -I "$ck/lib/XmlParserUtils" \
  "$here/crossink/opds-check.cpp" "$ck/lib/OpdsParser/OpdsParser.cpp" -lexpat -o "$cache/bin/opds-check-crossink"

"${cxx[@]}" \
  -I "$ck/test/content_opf_parser/stubs" \
  -I "$here/crosspoint/gtest-shim" \
  -I "$ck/lib/Epub/Epub/parsers" \
  -I "$ck/lib/XmlParserUtils" \
  -I "$ck/lib/Utf8" \
  -I "$ck/lib/Memory" \
  -I "$ck/lib/MemoryBudget" \
  "$here/crossink/opf-check.cpp" \
  "$ck/lib/Epub/Epub/parsers/ContentOpfParser.cpp" \
  "$ck/lib/Utf8/Utf8.cpp" \
  -lexpat -o "$cache/bin/opf-check-crossink"

"${cxx[@]}" "$here/crosspoint/xml-check.cpp" -lexpat -o "$cache/bin/xml-check"

echo "CrossInk $crossink_tag $crossink_sha" >&2
echo "$cache/bin"
