#!/usr/bin/env bash

set -e
SH=$(realpath $0) && SH=${SH%/*}
. $SH/cov
set -x

{
  if [ -f .hook/ai_test.md ]; then
    cat .hook/ai_test.md
  else
    cat $SH/ai_test.md
  fi
  cat $tmpdir/cov
} | gemini -y -m gemini-3-flash-preview
# | iflow -y -i --thinking --autoEdit
