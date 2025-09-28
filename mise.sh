set -e
DIR=$(dirname "${BASH_SOURCE[0]}")

if echo ":$PATH:" | grep -q ":$DIR/bin:"; then
  exit 0
fi

set -a
. $DIR/env.sh
set +a
