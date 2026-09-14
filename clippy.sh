#!/usr/bin/env bash

set -e

DIR=$(dirname "${BASH_SOURCE[0]}") && . "$DIR/cd_cargo.sh"

if ! command -v fixrs >/dev/null 2>&1; then
  cargo install fixrs
fi

run() {
  fixrs
  cargo +nightly fmt
  cargo +nightly clippy -q \
    --tests --all-targets \
    --all-features --fix -Z unstable-options --allow-dirty "$@" -- \
    -D warnings \
    -W clippy::absolute_paths
}

cd_cargo run "$@"
