#!/usr/bin/env bash

DIR=$(realpath $0) && DIR=${DIR%/*}
cd $DIR/..

for pkg in webc_user webc_api; do
  while true; do
    echo "=== Publishing $pkg ==="
    if cargo publish --allow-dirty -p "$pkg"; then
      echo "=== Successfully published $pkg ==="
      break
    else
      echo "Wait for rate limit, retrying in 20s..."
      sleep 20
    fi
  done
done

echo "=== All crates published successfully ==="
