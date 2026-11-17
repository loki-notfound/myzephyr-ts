#!/usr/bin/env bash
# Check the built guide site (site/check_site.cjs): a page for every guide file, the strict policy on
# every page, no script, style attribute, external resource or absolute path, one level-1 heading and no
# skipped heading level per page, and every relative link and anchor resolves.
#
#   bin/check_site.sh [<site directory>]      (default build/site/, as bin/build_site.sh writes it)
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"
log "guide site check"
node site/check_site.cjs --site "${1:-$ROOT/build/site}"
