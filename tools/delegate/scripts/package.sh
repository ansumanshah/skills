#!/bin/sh
# Package the tested native build and the licenses shipped with its linked runtime.
set -eu

cd "$(dirname -- "$0")/.."
if [ "$(uname -s):$(uname -m)" != Darwin:arm64 ]; then
  echo 'The release package currently targets Apple silicon Macs.' >&2
  exit 1
fi

version=$(bin/delegate --version)
archive="delegate-${version#delegate }-darwin-arm64.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p dist "$work/licenses"
install -m 755 bin/delegate "$work/delegate"
cp ../../LICENSE "$work/LICENSE"
cp node_modules/@scriptc/runtime-darwin-arm64/artifacts/licenses/*.txt "$work/licenses/"
tar -czf "dist/$archive" -C "$work" delegate LICENSE licenses
cd dist
shasum -a 256 "$archive" > "$archive.sha256"
echo "dist/$archive"
