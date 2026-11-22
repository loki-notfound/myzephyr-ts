# 13. Building and verifying

Every release of zephyr-ts is built from pinned sources with the scripts in its repository, and can be
rebuilt and compared. This chapter explains how to verify a release, what `manifest.json` records, how
to reproduce the build from the tag, and which core sources are pinned. [BUILDING.md](../../BUILDING.md)
describes the build itself; this chapter does not repeat it.

## Verifying a release

A release carries five files: the package tarball, `manifest.json`, `SHA256SUMS`, `SHA256SUMS.asc` and
`KEYS.asc`. In the directory with the downloaded files:

```sh
gpg --import KEYS.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

- `KEYS.asc` is the maintainer key `31DA 39AB 43E0 CA67 F1F3  A661 BA2A FF22 DF8A 4A13`. Compare the
  fingerprint `gpg` prints with this one, and with the one in the repository's README, before you
  trust the key. The same key signs the release tags and every commit of the library.
- `SHA256SUMS.asc` is a detached signature of `SHA256SUMS` by that key.
- `SHA256SUMS` lists the tarball and `manifest.json` with their SHA-256.

The release notes also give the SHA-256 of the tarball and of the `zephyr.wasm` inside it. To check the
module inside the tarball of v2.3.0-sec.2-ts.2:

```sh
tar -xzOf loki-notfound-zephyr-ts-2.3.0-sec.2-ts.2.tgz package/dist/zephyr.wasm | sha256sum
```

The module differs from one release to the next when the bridge or the build settings change, also with
the same core pins; within a release it is one file for every platform.

## The signed tag

Releases are tagged `v<zephyr version>-sec.<N>-ts.<M>`: `sec.<N>` is the zephyr-backports tag number of
the pinned core, `ts.<M>` counts releases of this library on that core and restarts at 1 with a new
core tag. The package version is the tag without the `v`. Tags are annotated and signed by the
maintainer key, and never moved or reused. In a clone of the repository, with the key imported:

```sh
git fetch origin tag v2.3.0-sec.2-ts.2
git verify-tag v2.3.0-sec.2-ts.2
git rev-parse 'v2.3.0-sec.2-ts.2^{commit}'
```

The last command prints the commit the release was built from; `manifest.json` names it too.

## manifest.json

`manifest.json` records what went into a release:

| Key | Contents |
|---|---|
| `zephyr_ts` | the source commit, its `source_date_epoch` and the version |
| `artifacts` | every release file with its size and SHA-256 |
| `module` | the SHA-256 of the shipped module, glue, worker and browser entry (`dist/zephyr.wasm`, `dist/zephyr.js`, `dist/zephyr.worker.js`, `dist/zephyr-ts.browser.mjs` and others) |
| `core` | zephyr and zephyr-cpp: repository URL, tag and commit, the zephyr submodules, the release set and the release key |
| `typescript_base` | monero-ts: repository, tag and commit |
| `patches` | the two build-only core patches with their SHA-256 |
| `depends` | the dependency archives (Boost, CMake, OpenSSL, Unbound) with URL, version and SHA-256 |
| `runtime_dependencies` | the versions of the npm runtime dependencies the build used |
| `toolchain` | emsdk commit, Emscripten, CMake, Node.js, npm, and the build host |

Check `zephyr_ts.commit` against the tag, `artifacts` against `SHA256SUMS`, and `core` against the
table below and `bin/pins.sh` at the tag.

## Reproducing the build

The build is reproducible: at the tag, `bin/build.sh` and `bin/pack.sh` give the release tarball byte
for byte. The first release, v2.3.0-sec.2-ts.1, was built on Debian 13 and on Ubuntu 24.04 with
identical results; the release notes of each release say where it was built and compared. To repeat
it:

```sh
git clone https://github.com/loki-notfound/myzephyr-ts.git
cd myzephyr-ts
git checkout v2.3.0-sec.2-ts.2
bin/build.sh
bin/pack.sh
sha256sum build/package/*.tgz
```

Compare the hash with `SHA256SUMS`. The build needs the tools listed in
[BUILDING.md](../../BUILDING.md), in particular Node.js 22 and npm 10 (the toolchain section of
`manifest.json` names the exact versions), because Babel targets the running Node.js version and
another major version can produce different output. Building is supported on Linux x86_64 only.

The build fetches every input itself and checks each one by commit or SHA-256 (`bin/pins.sh`,
`package-lock.json`); a mismatch stops it. It initializes only the submodule `external/zephyr-cpp`;
do not run a recursive submodule update.

## The core pins

| Component | Version | Commit |
|---|---|---|
| zephyr-cpp (git submodule `external/zephyr-cpp`) | tag `v2.3.0-sec.1` | `3a2ee602ee28e6b7941b617ad4706349ad992641` |
| zephyr (cloned by the build at the pinned commit) | tag `v2.3.0-sec.2` | `8c6a120256b4bd887d6e7167d929d76e3507e0e5` |
| monero-ts (base of the repository's history) | `v0.11.22` | `f6569ca616c4723645a7bfae3a843a0358f5fca9` |

Both core tags belong to the zephyr-backports release set of 2026-11-07 and are signed by the
zephyr-backports release key `FB39 94F0 997C A6F0 43D7  2491 9EFF 03F5 27D2 40A1`
(`keys/zephyr-backports.asc` in the repository). The core is compiled unchanged apart from two
build-only patches in `patches/core/`, which select the portable wallet-crypto backend and add a
missing `#include <map>`.

To verify the core sources and their signatures:

```sh
bin/verify_sources.sh
```

It fetches the pinned trees when they are absent, checks every commit, and verifies both tags against
the release key in a temporary keyring.

## Building and checking this guide

The guide is Markdown under `docs/guide/` and is published as a static site. `bin/check_guide.sh`
type-checks every TypeScript example against an installed package and runs the offline ones;
`bin/build_site.sh` builds the site and `bin/check_site.sh` checks it. [BUILDING.md](../../BUILDING.md)
describes both.
