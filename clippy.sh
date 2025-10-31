#!/usr/bin/env bash

set -e
DIR=$(realpath $0) && DIR=${DIR%/*}
. $DIR/cd_cargo.sh
set -x

if ! hash cargo-clippy 2>/dev/null; then
  rustup component add clippy
fi

git add -u && git commit -m'.' || true

# dasel ".workspace.members.all()" -r toml -f Cargo.toml | xargs cargo fmt -p

cargo +nightly clippy --all-targets --all-features --fix -Z unstable-options -- \
  -A clippy::uninit_assumed_init

cargo fmt
