#!/usr/bin/env bash

if [ -z "$1" ]; then
  echo "$0 <bin>"
  exit 1
fi

if ! hash "${2:-$1}" 2>/dev/null; then
  if hash cargo-binstall 2>/dev/null; then
    cargo binstall -y $1
  else
    cargo install $1
  fi
fi
