#!/usr/bin/env bash

set -e

CHECK="cargo check --tests --all-targets --all-features"

set -x
$CHECK
set +x

DIR=$(realpath $0) && DIR=${DIR%/*}

fd -e rs -x sd '#\[allow\(clippy::absolute_paths\)\]' ''

ai() {
  local cmd="iflow -y $@"
  echo "❯ $cmd"
  eval $cmd
}

LOG=/tmp/fix

fix_loop() {
  local cmd=$1
  local check_fn=$2
  local prompt_msg="先 cat $LOG 查看, ${3:-" 修复报警\n2. 再次运行 $cmd ，确保没有警告、报错"}"
  local arg="-p"
  local last_lines=0
  local unchanged_count=0

  while true; do
    echo "❯ $cmd"
    bash -c "$cmd" 2>&1 | tee $LOG
    local current_lines=$(wc -l <$LOG)
    if [ "$current_lines" -eq 0 ]; then
      break
    fi

    if [ "$current_lines" -eq "$last_lines" ]; then
      unchanged_count=$((unchanged_count + 1))
    else
      unchanged_count=0
      last_lines=$current_lines
    fi

    if [ "$unchanged_count" -ge 3 ]; then
      echo "⚠️ LOG 行数连续 3 次未变 ($current_lines)，退出循环。"
      cat $LOG
      break
    fi

    if $check_fn $LOG; then
      ai $arg "'$prompt_msg'"
      arg="-c -p"
      $CHECK 2>&1 | tee $LOG.check || ai $arg "'cat $LOG.check , 修复 $CHECK 错误'"
      rm $LOG.check
    else
      break
    fi
  done
}

has_line() {
  [ -s "$1" ]
}

PROMPT_CHECK="，改完后 ${CHECK}，验证修改正确"

check_use() {
  local cmd=$1
  local scope=$2
  local prefix="${scope}::"
  local prompt="用 use ${prefix}方式导入(但禁止用pub use)，再使用，避免内联写 ${scope}::xxx （注释，也不写${scope}::xxx, 直接写xxx），${PROMPT_CHECK}"

  fix_loop "$cmd" has_line "$prompt"
}

check_ns_use() {
  local ns=$1
  local filter=${2:-"="}
  check_use "rg \"${ns}::\" -t rust | rg \"$filter\"" "$ns"
}

check_ns_use consts
check_ns_use std
check_ns_use super
check_ns_use log "!"
check_use "rg '(^|[^$])crate::' -t rust | rg -v \":\s*use \" | rg -v \":\s*//\"" crate

fix_loop 'rg -t rs RapidHashMap|rg -v " as Map"' has_line "请在文件开头用 use rapidhash::RapidHashMap as Map; 的简化 RapidHashMap 别名（注释中，也不写RapidHashMap, 直接写Map）${PROMPT_CHECK}"

has_warnings() {
  grep -qiE '^(warning|error):' "$1"
}

# 2. 运行 Clippy 修复
fix_loop "$DIR/clippy.sh 2>&1 | rg -v '^\s+Checking\s'" \
  has_warnings

rm $LOG
$DIR/udep.sh
echo ✅
