#!/usr/bin/env bash
# Fetch (when absent) and verify the pinned core sources:
#   external/zephyr-cpp                     git submodule, must be at ZEPHYR_CPP_COMMIT
#   external/zephyr-cpp/external/zephyr     cloned at ZEPHYR_COMMIT (zephyr-cpp records no commit for it)
#   .../external/zephyr/external/randomx    zephyr submodule at RANDOMX_COMMIT
#   .../external/zephyr/external/rapidjson  zephyr submodule at RAPIDJSON_COMMIT
# and check that tags ZEPHYR_CPP_TAG and ZEPHYR_TAG point to these commits and carry a valid
# signature of the zephyr-backports release key, in a temporary keyring.
#
# Other zephyr submodules are not needed and stay uninitialized. The repository's own submodule
# update is limited to external/zephyr-cpp; never run a recursive update.
#
# Environment (optional): ZEPHYR_CPP_URL, ZEPHYR_URL, RANDOMX_URL, RAPIDJSON_URL to fetch from a
# local mirror; every fetched tree is still verified by commit and signature.
set -euo pipefail
. "$(dirname "$0")/pins.sh"
cd "$ROOT"

command -v git >/dev/null || die "git is required"
command -v gpg >/dev/null || die "gpg is required"

head_of() { git -C "$1" rev-parse HEAD 2>/dev/null || true; }

log "zephyr-cpp"
if [ ! -e "$ZEPHYR_CPP_DIR/.git" ]; then
  local_url=(); [[ "$ZEPHYR_CPP_URL" == file://* ]] && local_url=(-c protocol.file.allow=always) # a local mirror named by the caller
  git "${local_url[@]}" -c "submodule.external/zephyr-cpp.url=$ZEPHYR_CPP_URL" submodule update --init external/zephyr-cpp \
    || die "could not fetch external/zephyr-cpp"
fi
[ "$(head_of "$ZEPHYR_CPP_DIR")" = "$ZEPHYR_CPP_COMMIT" ] || die "external/zephyr-cpp is not at $ZEPHYR_CPP_COMMIT"
git -C "$ZEPHYR_CPP_DIR" rev-parse -q --verify "refs/tags/$ZEPHYR_CPP_TAG" >/dev/null \
  || git -C "$ZEPHYR_CPP_DIR" fetch -q "$ZEPHYR_CPP_URL" "refs/tags/$ZEPHYR_CPP_TAG:refs/tags/$ZEPHYR_CPP_TAG" \
  || die "tag $ZEPHYR_CPP_TAG not available"

log "zephyr"
if [ ! -e "$ZEPHYR_DIR/.git" ]; then
  [ ! -e "$ZEPHYR_DIR" ] || [ -z "$(ls -A "$ZEPHYR_DIR")" ] || die "$ZEPHYR_DIR exists and is not a git checkout"
  git clone -q --no-checkout "$ZEPHYR_URL" "$ZEPHYR_DIR" || die "could not clone zephyr"
  git -C "$ZEPHYR_DIR" -c advice.detachedHead=false checkout -q --detach "$ZEPHYR_COMMIT" || die "zephyr commit $ZEPHYR_COMMIT not available"
fi
[ "$(head_of "$ZEPHYR_DIR")" = "$ZEPHYR_COMMIT" ] || die "zephyr is not at $ZEPHYR_COMMIT"
git -C "$ZEPHYR_DIR" rev-parse -q --verify "refs/tags/$ZEPHYR_TAG" >/dev/null \
  || git -C "$ZEPHYR_DIR" fetch -q "$ZEPHYR_URL" "refs/tags/$ZEPHYR_TAG:refs/tags/$ZEPHYR_TAG" \
  || die "tag $ZEPHYR_TAG not available"

log "zephyr submodules randomx and rapidjson"
for m in randomx rapidjson; do
  if [ ! -e "$ZEPHYR_DIR/external/$m/.git" ]; then
    git -C "$ZEPHYR_DIR" submodule init "external/$m"
    var=$(echo "$m" | tr a-z A-Z)_URL
    if [ -n "${!var:-}" ]; then git -C "$ZEPHYR_DIR" config "submodule.external/$m.url" "${!var}"; fi
    local_url=(); [[ "$(git -C "$ZEPHYR_DIR" config "submodule.external/$m.url")" == file://* ]] && local_url=(-c protocol.file.allow=always)
    git -C "$ZEPHYR_DIR" "${local_url[@]}" submodule update "external/$m" || die "could not fetch zephyr submodule $m"
  fi
done
[ "$(head_of "$ZEPHYR_DIR/external/randomx")" = "$RANDOMX_COMMIT" ] || die "randomx is not at $RANDOMX_COMMIT"
[ "$(head_of "$ZEPHYR_DIR/external/rapidjson")" = "$RAPIDJSON_COMMIT" ] || die "rapidjson is not at $RAPIDJSON_COMMIT"
[ "$(git -C "$ZEPHYR_DIR" ls-tree HEAD external/randomx | awk '{print $3}')" = "$RANDOMX_COMMIT" ] || die "zephyr does not record randomx $RANDOMX_COMMIT"
[ "$(git -C "$ZEPHYR_DIR" ls-tree HEAD external/rapidjson | awk '{print $3}')" = "$RAPIDJSON_COMMIT" ] || die "zephyr does not record rapidjson $RAPIDJSON_COMMIT"

log "release key and tag signatures"
echo "$BACKPORTS_KEY_FILE_SHA256  $ROOT/keys/zephyr-backports.asc" | sha256sum -c --quiet - || die "keys/zephyr-backports.asc does not match its pinned hash"
GNUPGHOME=$(mktemp -d); export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --import "$ROOT/keys/zephyr-backports.asc" 2>/dev/null
gpg --batch --with-colons --fingerprint "$BACKPORTS_KEY_FINGERPRINT" | grep -q "^fpr:::::::::$BACKPORTS_KEY_FINGERPRINT:$" \
  || die "release key $BACKPORTS_KEY_FINGERPRINT not in keys/zephyr-backports.asc"
verify_tag() { # dir tag commit
  local got out
  got=$(git -C "$1" rev-parse "refs/tags/$2^{commit}")
  [ "$got" = "$3" ] || die "tag $2 points to $got, not $3"
  out=$(git -C "$1" -c gpg.program=gpg verify-tag --raw "$2" 2>&1) || die "tag $2: signature does not verify"
  grep -q "^\[GNUPG:\] VALIDSIG .* $BACKPORTS_KEY_FINGERPRINT$" <<<"$out" || die "tag $2 is not signed by $BACKPORTS_KEY_FINGERPRINT"
  ! grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG)' <<<"$out" || die "tag $2: bad signature status"
  echo "tag $2 -> $3: valid signature, primary key $BACKPORTS_KEY_FINGERPRINT"
}
verify_tag "$ZEPHYR_CPP_DIR" "$ZEPHYR_CPP_TAG" "$ZEPHYR_CPP_COMMIT"
verify_tag "$ZEPHYR_DIR" "$ZEPHYR_TAG" "$ZEPHYR_COMMIT"
echo "sources verified"
