#!/usr/bin/env bash

DIR=$(realpath ${0%/*})
cd $DIR

if [ ! -n "$1" ]; then
  echo "USAGE : $0 project_name"
  exit 1
fi

set -ex

cd ..

github_repo=$(git remote get-url origin | node -e "process.stdin.setEncoding('utf8');
process.stdin.on('data', d => console.log(d.split(':').pop().slice(0,-5).replace('443/','')))")

cargo new --lib $1 # this will add lib to workspace

rm -rf $1

cp -R $DIR/_tmpl $1

cd $1

rpl _tmpl $1

rpl "i18n-site/rust-template" "$github_repo"

git add .
