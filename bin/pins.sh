# Pinned build inputs of zephyr-ts. Sourced by the other scripts in bin/; not executable on its own.
#
# The core is the signed zephyr-backports release set. Every input below is identified by a full
# commit or a SHA-256; the scripts verify each identity before use and stop on any mismatch.

# zephyr-cpp: git submodule external/zephyr-cpp (tag v2.3.0-sec.1)
ZEPHYR_CPP_COMMIT=3a2ee602ee28e6b7941b617ad4706349ad992641
ZEPHYR_CPP_TAG=v2.3.0-sec.1
ZEPHYR_CPP_URL=${ZEPHYR_CPP_URL:-https://github.com/zephyr-backports/zephyr-cpp.git}

# zephyr: cloned into external/zephyr-cpp/external/zephyr (tag v2.3.0-sec.2). zephyr-cpp records no
# commit for this tree, so it is pinned here.
ZEPHYR_COMMIT=8c6a120256b4bd887d6e7167d929d76e3507e0e5
ZEPHYR_TAG=v2.3.0-sec.2
ZEPHYR_URL=${ZEPHYR_URL:-https://github.com/zephyr-backports/zephyr.git}

# the two zephyr submodules the build needs (commits recorded by the zephyr tree itself)
RANDOMX_COMMIT=12f2c2ffe2108d6cf54c391fee33c8bc3646cdab
RAPIDJSON_COMMIT=129d19ba7f496df5e33658527a7158c79b99c21c

# zephyr-backports release key (keys/zephyr-backports.asc); it signs both tags above
BACKPORTS_KEY_FINGERPRINT=FB3994F0997CA6F043D724919EFF03F527D240A1
BACKPORTS_KEY_FILE_SHA256=f635be8f8a6cfdc8b54d8ed13d078d534b8da419e8ffd57e0306f2051a0ca9f3

# reference wallet library for the optional two-way file compatibility test (tag v2.3.0-sec.1)
ZEPHYR_JAVASCRIPT_COMMIT=7b17a14280bd84ca783287f4640b3c744d25319f
ZEPHYR_JAVASCRIPT_TAG=v2.3.0-sec.1
ZEPHYR_JAVASCRIPT_URL=${ZEPHYR_JAVASCRIPT_URL:-https://github.com/zephyr-backports/zephyr-javascript.git}

# toolchain
EMSDK_COMMIT=d7b4130688bfa348392b921ab04015aa15c4f154
EMSDK_URL=${EMSDK_URL:-https://github.com/emscripten-core/emsdk.git}
EMSCRIPTEN_VERSION=3.1.10
EMSDK_NODE_SUBDIR=node/24.19.0_64bit

# archives: file name, URL, SHA-256
CMAKE_ARCHIVE=cmake-3.27.9-linux-x86_64.tar.gz
CMAKE_URL=https://github.com/Kitware/CMake/releases/download/v3.27.9/cmake-3.27.9-linux-x86_64.tar.gz
CMAKE_SHA256=72b01478eeb312bf1a0136208957784fe55a7b587f8d9f9142a7fc9b0b9e9a28
BOOST_ARCHIVE=boost_1_84_0.tar.gz
BOOST_URL=https://archives.boost.io/release/1.84.0/source/boost_1_84_0.tar.gz
BOOST_SHA256=a5800f405508f5df8114558ca9855d2640a2de8f0445f051fa1c7c3383045724
OPENSSL_ARCHIVE=openssl-3.6.5.tar.gz
OPENSSL_URL=https://github.com/openssl/openssl/releases/download/openssl-3.6.5/openssl-3.6.5.tar.gz
OPENSSL_SHA256=a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98
UNBOUND_ARCHIVE=unbound-1.19.1.tar.gz
UNBOUND_URL=https://nlnetlabs.nl/downloads/unbound/unbound-1.19.1.tar.gz
UNBOUND_SHA256=bc1d576f3dd846a0739adc41ffaa702404c6767d2b6082deb9f2f97cbb24a3a9

# build-only patches applied to the core trees before compiling (see patches/core/)
CORE_PATCH_ZEPHYR=patches/core/zephyr-0001-wallet-crypto-library-cn.patch
CORE_PATCH_ZEPHYR_SHA256=30dd1a45dc1414afae43e2500692cfd609bbbbad0a6f2748b30a32486e89ed8d
CORE_PATCH_ZEPHYR_CPP=patches/core/zephyr-cpp-0001-include-map.patch
CORE_PATCH_ZEPHYR_CPP_SHA256=389ff6b96128ff9232389239bfc916e66fbc250102ccd2e8e79393031b2360a3

# locations inside the repository (all ignored by git)
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ZEPHYR_CPP_DIR=$ROOT/external/zephyr-cpp
ZEPHYR_DIR=$ZEPHYR_CPP_DIR/external/zephyr
TOOLCHAIN_DIR=$ROOT/build/toolchain
DOWNLOAD_DIR=$ROOT/build/downloads
DEPS_DIR=$ROOT/build/deps

# toolchain environment for the build scripts (no change outside this repository)
use_toolchain() {
  export EMSDK=$TOOLCHAIN_DIR/emsdk
  export EM_CONFIG=$EMSDK/.emscripten
  export EM_CACHE=$EMSDK/upstream/emscripten/cache
  export EMSDK_NODE=$EMSDK/$EMSDK_NODE_SUBDIR/bin/node
  export EMSCRIPTEN=$EMSDK/upstream/emscripten
  export PATH=$TOOLCHAIN_DIR/cmake/bin:$EMSDK/upstream/emscripten:$EMSDK/upstream/bin:$PATH
  export TZ=UTC
}

log() { printf '\n=== %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { echo "error: $*" >&2; exit 1; }
