#!/usr/bin/env bash
set -e
DIR=$(dirname "${BASH_SOURCE[0]}") && . "$DIR/cd_cargo.sh"

export CARGO_REGISTRIES_CRATES_IO_PROTOCOL=git

if ! command -v cargo-upgrade >/dev/null 2>&1; then
  cargo install cargo-edit
fi

run() {
  set -x
  cargo update
  cargo upgrade --recursive --verbose --incompatible
  set +x
}

cd_cargo run "$@"

set -x
if [ -f "package.json" ]; then
  ncu -u
  bun i
  bun x cargo_upgrade
fi
