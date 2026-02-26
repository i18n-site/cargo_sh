#!/usr/bin/env bash

set -ex

fd -t f -e rs --hidden --exclude '*tests*' \
  -x sd '.*dbg!\s*\(.*\)\n?' '' {}

cargo fmt
