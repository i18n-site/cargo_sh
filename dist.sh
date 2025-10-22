#!/usr/bin/env bash

if [ $# -eq 0 ]; then
  echo "usage: $0 <project>"
  exit 1
fi

DIR=$(realpath $0) && DIR=${DIR%/*}

CMDPWD=$(pwd)
cd $DIR

./cargo_install.sh toml-cli toml

git pull

dist() {
  cd $CMDPWD/$1
  name=$(toml get Cargo.toml -r package.name)
  cargo build -p $name

  bun x mdt .
  git add .
  rm -rf Cargo.lock
  touch Cargo.lock
  cargo v patch -y

  git describe --tags $(git rev-list --tags --max-count=1) | xargs git tag -d

  rm Cargo.lock
  git add -u
  git commit -m. || true
  git push
  cargo publish --registry crates-io --allow-dirty || true
  cd $DIR/..
  bun x cargo_upgrade
  rm Cargo.lock
  git add -u
  gme $(cargo metadata --format-version=1 --no-deps | jq '.packages[] | .name + ":" + .version' -r | grep "$name:") || true

}

set -ex

rm -rf Cargo.lock
# ./clippy.sh

if ! [ -x "$(command -v cargo-v)" ]; then
  cargo install cargo-v
fi

for arg in "$@"; do
  dist $arg
done
