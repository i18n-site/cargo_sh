#!/usr/bin/env bash
set -ex

SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rsync -avz --ignore-existing "$SH_DIR/init/" .

if [ ! -e ".mise.toml" ]; then
  ln -s sh/_mise.toml .mise.toml
fi

mkdir -p .agents/skills
for dir in "$SH_DIR/skills"/*; do
  [ -d "$dir" ] || continue
  ln -snf "$dir" ".agents/skills/$(basename "$dir")"
done

bun i
mise trust || true
