#!/usr/bin/env bash
set -e
DIR=$(realpath $0) && DIR=${DIR%/*}
. $DIR/cd_cargo.sh
set -x
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL=git
deltmp
cargo update
cargo upgrade -i --recursive --verbose
ncu -u
bun i
bun x cargo_upgrade
