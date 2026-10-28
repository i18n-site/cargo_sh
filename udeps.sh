#!/usr/bin/env bash

# 检测未使用的依赖

set -ex

if ! hash cargo-machete 2>/dev/null; then
  cargo install cargo-machete
fi

# machete 退出码即判定（0=无未用依赖 1=有 2=出错）：不再 || true 恒绿
fix_rc=0
RUST_LOG=warn cargo machete --fix || fix_rc=$?

# --fix 改写留痕：列出被 --fix 改写的清单，再落判定
changed=$(git diff --name-only -- '*Cargo.toml' 2>/dev/null || true)
if [ -n "$changed" ]; then
  echo ">>> cargo machete --fix 已改写以下 Cargo.toml，请 git diff 审阅后决定去留："
  echo "$changed"
fi

if [ "$fix_rc" -ne 0 ]; then
  echo "❌ cargo machete 非零退出（exit ${fix_rc}），未用依赖/出错，红" >&2
  exit "$fix_rc"
fi

if [ -f "hook/udeps.sh" ]; then
  hook/udeps.sh
fi

# if ! hash cargo-udeps 2>/dev/null; then
#   cargo install cargo-udeps --locked
# fi
#
# cargo +nightly udeps --workspace --all-features --output json | direnv exec . ./udeps.coffee
