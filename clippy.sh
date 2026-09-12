#!/usr/bin/env bash

set -e
DIR=$(realpath $0) && DIR=${DIR%/*}
. $DIR/cd_cargo.sh

cargo +nightly fmt

# dasel ".workspace.members.all()" -r toml -f Cargo.toml | xargs cargo fmt -p
set -x

exec cargo +nightly clippy -q \
  --tests --all-targets \
  --all-features --fix -Z unstable-options --allow-dirty -- \
  -D warnings \
  -W clippy::absolute_paths
