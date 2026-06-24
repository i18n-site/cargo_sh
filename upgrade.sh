#!/usr/bin/env bash
set -e
DIR=$(realpath $0) && DIR=${DIR%/*}
. $DIR/cd_cargo.sh
set -x
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL=git
cargo update

if ! command -v cargo-upgrade 2>/dev/null; then
  cargo install cargo-upgrades
fi

cargo upgrade --recursive --verbose --incompatible
ncu -u
bun i
bun x cargo_upgrade
