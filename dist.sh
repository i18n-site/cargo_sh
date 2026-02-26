#!/usr/bin/env bash

set -x
if [ $# -eq 0 ]; then
  echo "usage: $0 <project>"
  exit 1
fi
DIR=$(realpath $0) && DIR=${DIR%/*}
. $DIR/cd_cargo.sh
set -e

WORKSPACE=$(pwd)
cd $WORKSPACE

$DIR/cargo_install.sh toml-cli toml

git pull

dist() {
  cd $WORKSPACE/$1
  name=$(toml get Cargo.toml -r package.name)
  cargo build -p $name

  bun x mdt .
  git add .
  rm -f Cargo.lock
  touch Cargo.lock
  cargo v patch -y

  git describe --tags $(git rev-list --tags --max-count=1) | xargs git tag -d

  rm -f Cargo.lock
  git add -u
  git commit -m. || true
  git push
  cargo publish --registry crates-io --allow-dirty || true
  cd $WORKSPACE
  bun x cargo_upgrade
  rm -f Cargo.lock
  git add -u
  gme $(cargo metadata --format-version=1 --no-deps | jq '.packages[] | .name + ":" + .version' -r | grep "$name:") || true

}

set -ex

rm -f Cargo.lock
# ./clippy.sh

if ! [ -x "$(command -v cargo-v)" ]; then
  cargo install cargo-v
fi

for arg in "$@"; do
  dist $arg
done
