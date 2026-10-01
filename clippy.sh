#!/usr/bin/env bash

set -e

DIR=$(dirname "${BASH_SOURCE[0]}")
[ -f "$DIR/env.sh" ] && . "$DIR/env.sh"
. "$DIR/cd_cargo.sh"

if ! command -v fixrs >/dev/null 2>&1; then
  cargo install fixrs
fi

run() {
  fixrs
  cargo +nightly fmt
  set -x
  cargo +nightly clippy -q \
    --tests --all-targets \
    --all-features --fix -Z unstable-options --allow-dirty "$@" -- \
    -D warnings \
    -W clippy::absolute_paths
  set +x
}

cd_cargo run "$@"
