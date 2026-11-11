#!/usr/bin/env bash
# Acquire the pinned toolchain and dependency archives into build/ (nothing is installed outside
# this repository):
#   build/toolchain/emsdk   emsdk at EMSDK_COMMIT with Emscripten EMSCRIPTEN_VERSION
#   build/toolchain/cmake   CMake from its release archive
#   build/downloads/        Boost, OpenSSL and Unbound source archives
# Every archive is checked against its pinned SHA-256 before use.
#
# Environment (optional):
#   EMSDK_SOURCE_DIR  an existing emsdk checkout at EMSDK_COMMIT with EMSCRIPTEN_VERSION installed;
#                     it is copied (never used in place). Without it, emsdk is cloned and
#                     "emsdk install" downloads the release binaries.
#   ARCHIVE_DIR       a directory with already downloaded archives (copied, then verified)
#   OFFLINE=1         never download; fail if an input is not available locally
set -euo pipefail
. "$(dirname "$0")/pins.sh"
mkdir -p "$TOOLCHAIN_DIR" "$DOWNLOAD_DIR"

emsdk_ok() { # dir
  [ "$(git -C "$1" rev-parse HEAD 2>/dev/null)" = "$EMSDK_COMMIT" ] \
    && grep -qx "\"$EMSCRIPTEN_VERSION\"" "$1/upstream/emscripten/emscripten-version.txt" 2>/dev/null
}

log "emsdk $EMSCRIPTEN_VERSION at $EMSDK_COMMIT"
if [ ! -d "$TOOLCHAIN_DIR/emsdk" ]; then
  if [ -n "${EMSDK_SOURCE_DIR:-}" ]; then
    emsdk_ok "$EMSDK_SOURCE_DIR" || die "EMSDK_SOURCE_DIR is not emsdk $EMSDK_COMMIT with Emscripten $EMSCRIPTEN_VERSION"
    cp -a --no-preserve=links "$EMSDK_SOURCE_DIR" "$TOOLCHAIN_DIR/emsdk"
  else
    [ "${OFFLINE:-0}" != 1 ] || die "OFFLINE=1 and no EMSDK_SOURCE_DIR"
    git clone -q --no-checkout "$EMSDK_URL" "$TOOLCHAIN_DIR/emsdk"
    git -C "$TOOLCHAIN_DIR/emsdk" -c advice.detachedHead=false checkout -q --detach "$EMSDK_COMMIT"
    ( cd "$TOOLCHAIN_DIR/emsdk" && ./emsdk install "$EMSCRIPTEN_VERSION" && ./emsdk activate "$EMSCRIPTEN_VERSION" )
  fi
fi
emsdk_ok "$TOOLCHAIN_DIR/emsdk" || die "build/toolchain/emsdk is not emsdk $EMSDK_COMMIT with Emscripten $EMSCRIPTEN_VERSION"
[ -z "$(find "$TOOLCHAIN_DIR/emsdk" -type l -lname '/*' -print -quit)" ] || die "build/toolchain/emsdk contains absolute symbolic links"
echo "emsdk $EMSDK_COMMIT, Emscripten $EMSCRIPTEN_VERSION"

fetch() { # file url sha256
  local f=$DOWNLOAD_DIR/$1
  if [ ! -f "$f" ]; then
    if [ -n "${ARCHIVE_DIR:-}" ] && [ -f "$ARCHIVE_DIR/$1" ]; then cp "$ARCHIVE_DIR/$1" "$f.part"
    else
      [ "${OFFLINE:-0}" != 1 ] || die "OFFLINE=1 and $1 is not in ARCHIVE_DIR"
      curl -fsSL --proto '=https' -o "$f.part" "$2" || die "download of $1 failed"
    fi
    mv "$f.part" "$f"
  fi
  echo "$3  $f" | sha256sum -c --quiet - || { rm -f "$f"; die "$1 does not match its pinned SHA-256"; }
  echo "$1 sha256 $3"
}
log "archives"
fetch "$CMAKE_ARCHIVE" "$CMAKE_URL" "$CMAKE_SHA256"
fetch "$BOOST_ARCHIVE" "$BOOST_URL" "$BOOST_SHA256"
fetch "$OPENSSL_ARCHIVE" "$OPENSSL_URL" "$OPENSSL_SHA256"
fetch "$UNBOUND_ARCHIVE" "$UNBOUND_URL" "$UNBOUND_SHA256"
if [ ! -x "$TOOLCHAIN_DIR/cmake/bin/cmake" ]; then
  rm -rf "$TOOLCHAIN_DIR/cmake" "$TOOLCHAIN_DIR/cmake.tmp"; mkdir -p "$TOOLCHAIN_DIR/cmake.tmp"
  tar xzf "$DOWNLOAD_DIR/$CMAKE_ARCHIVE" -C "$TOOLCHAIN_DIR/cmake.tmp" --strip-components=1
  mv "$TOOLCHAIN_DIR/cmake.tmp" "$TOOLCHAIN_DIR/cmake"
fi
"$TOOLCHAIN_DIR/cmake/bin/cmake" --version | head -n 1
echo "toolchain ready"
