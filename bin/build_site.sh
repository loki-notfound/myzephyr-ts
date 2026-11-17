#!/usr/bin/env bash
# Build the static guide site from docs/guide/ into build/site/ (site/build_site.cjs): one page per
# Markdown file with the house stylesheet, relative links only, no JavaScript. Needs Node.js and git
# (the footer names the package version and the commit); nothing is installed.
#
#   bin/build_site.sh [<output directory>]
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
export TZ=UTC
log "guide site"
node site/build_site.cjs --out "${1:-$ROOT/build/site}"
