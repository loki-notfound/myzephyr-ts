#!/usr/bin/env bash
# Build the WebAssembly modules from the verified sources (run bin/verify_sources.sh and
# bin/fetch_toolchain.sh first):
#   dist/zephyr.js, dist/zephyr.wasm             release module (glue and separate module)
#   dist/zephyr.test.js, dist/zephyr.test.wasm   test module with ZEPHYR_TS_TEST_INSTRUMENTATION, for the
#                                                instrumented test suite only; never shipped
# Steps (all by default): patch deps release test
#   patch    apply the two build-only patches of patches/core/ to the core trees (idempotent)
#   deps     host build of the zephyr translations, Boost libraries, OpenSSL and Unbound headers
#   release  configure and build the release module
#   test     configure and build the test module from the same sources
set -euo pipefail
. "$(dirname "$0")/pins.sh"
use_toolchain
STEPS=${*:-patch deps release test}
has() { [[ " $STEPS " == *" $1 "* ]]; }
NCPU=$(nproc)
LOGS=$ROOT/build/logs; mkdir -p "$LOGS" "$DEPS_DIR"
# compile from the repository root with relative paths (bin/relpath_launcher.sh) and map the root,
# so that no build path is recorded in the outputs
export CFLAGS="-ffile-prefix-map=$ROOT=/myzephyr-ts"
export CXXFLAGS="-I$DEPS_DIR/unbound-1.19.1/libunbound $CFLAGS"

apply_once() { # tree patch sha256
  echo "$3  $ROOT/$2" | sha256sum -c --quiet - || die "$2 does not match its pinned SHA-256"
  if git -C "$1" apply --reverse --check "$ROOT/$2" 2>/dev/null; then echo "already applied: $2"; return; fi
  git -C "$1" apply --check "$ROOT/$2" && git -C "$1" apply "$ROOT/$2"
  echo "applied: $2"
}

if has patch; then
  log "build-only core patches"
  apply_once "$ZEPHYR_DIR" "$CORE_PATCH_ZEPHYR" "$CORE_PATCH_ZEPHYR_SHA256"
  apply_once "$ZEPHYR_CPP_DIR" "$CORE_PATCH_ZEPHYR_CPP" "$CORE_PATCH_ZEPHYR_CPP_SHA256"
fi

if has deps; then
  log "zephyr translations (host build)"
  T=$ZEPHYR_DIR/build/release/translations; rm -rf "$T"; mkdir -p "$T"
  ( cd "$T" && CC=gcc CXX=g++ CFLAGS= CXXFLAGS= cmake -S "$ZEPHYR_DIR/translations" -B . -DCMAKE_BUILD_TYPE=Release > "$LOGS/translations.log" 2>&1 \
      && make >> "$LOGS/translations.log" 2>&1 ) || die "translations build failed (build/logs/translations.log)"
  log "Boost 1.84.0 libraries (Emscripten)"
  B=$ZEPHYR_CPP_DIR/external/boost-sdk; rm -rf "$B"; mkdir -p "$B"
  tar xzf "$DOWNLOAD_DIR/$BOOST_ARCHIVE" -C "$B" --strip-components=1
  ( cd "$EMSCRIPTEN" && python3 ./embuilder.py build zlib ) > "$LOGS/boost.log" 2>&1
  ( cd "$B" && export NO_BZIP2=1 && CFLAGS= CXXFLAGS= ./bootstrap.sh --with-libraries=system,thread,chrono,serialization,regex,filesystem \
      && cat "$ROOT/configs/emscripten.jam" >> project-config.jam \
      && rm -rf "$ROOT/build/boost" && mkdir -p "$ROOT/build/boost" \
      && CFLAGS= CXXFLAGS= ./b2 -q -a -j "$NCPU" toolset=clang-emscripten threading=single link=static optimization=space variant=release cxxflags=-no-pthread stage --stagedir="$ROOT/build/boost" ) >> "$LOGS/boost.log" 2>&1 \
    || die "Boost build failed (build/logs/boost.log)"
  ln -sfn "$B" "$ROOT/build/boost/include"
  [ -f "$ROOT/build/boost/lib/libboost_system.a" ] || "$EMSCRIPTEN/emar" rc "$ROOT/build/boost/lib/libboost_system.a" # header-only since Boost 1.69
  log "OpenSSL 3.6.5 headers"
  O=$ZEPHYR_CPP_DIR/external/openssl-sdk; rm -rf "$O"; mkdir -p "$O"; tar xzf "$DOWNLOAD_DIR/$OPENSSL_ARCHIVE" -C "$O" --strip-components=1
  ( cd "$O" && CC=gcc CFLAGS= perl ./Configure linux-generic32 no-asm no-ssl3 no-comp no-engine no-tests no-dso no-shared no-threads > "$LOGS/openssl.log" 2>&1 \
      && make build_generated >> "$LOGS/openssl.log" 2>&1 ) || die "OpenSSL header generation failed (build/logs/openssl.log)"
  rm -rf "$ROOT/build/openssl"; mkdir -p "$ROOT/build/openssl/include"; cp -r "$O/include/openssl" "$ROOT/build/openssl/include/openssl"
  log "Unbound 1.19.1 headers"
  rm -rf "$DEPS_DIR/unbound-1.19.1"; tar xzf "$DOWNLOAD_DIR/$UNBOUND_ARCHIVE" -C "$DEPS_DIR"
  [ -f "$DEPS_DIR/unbound-1.19.1/libunbound/unbound.h" ] || die "unbound.h missing"
fi

module() { # build-dir instrumentation(ON|OFF) output-stem
  local dir=$ROOT/build/$1
  rm -rf "$dir"; mkdir -p "$dir"
  ( cd "$dir" && RELPATH_ROOT="$ROOT" emcmake cmake ../.. -DZEPHYR_TS_TEST_INSTRUMENTATION="$2" \
      -DCMAKE_C_COMPILER_LAUNCHER="$ROOT/bin/relpath_launcher.sh" -DCMAKE_CXX_COMPILER_LAUNCHER="$ROOT/bin/relpath_launcher.sh" > "$LOGS/cmake-$1.log" 2>&1 \
      && RELPATH_ROOT="$ROOT" emmake cmake --build . -j"$NCPU" >> "$LOGS/cmake-$1.log" 2>&1 ) \
    || { grep -m20 -E "error:|Error " "$LOGS/cmake-$1.log" || true; die "module build failed (build/logs/cmake-$1.log)"; }
  grep -q "ZEPHYR_TS_TEST_INSTRUMENTATION:BOOL=$2" "$dir/CMakeCache.txt" || die "instrumentation option is not $2"
  [ -s "$dir/zephyr.js" ] && [ -s "$dir/zephyr.wasm" ] || die "the link did not produce zephyr.js and zephyr.wasm"
  mkdir -p "$ROOT/dist"
  cp "$dir/zephyr.js" "$ROOT/dist/$3.js"; cp "$dir/zephyr.wasm" "$ROOT/dist/$3.wasm"
  ( cd "$ROOT" && sha256sum "dist/$3.js" "dist/$3.wasm" )
}
if has release; then log "release module"; module wasm OFF zephyr; fi
if has test; then log "test module"; module wasm-test ON zephyr.test; fi
log "done: $STEPS"
