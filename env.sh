#!/usr/bin/env bash

set -a
RUSTFLAGS="$RUSTFLAGS --cfg reqwest_unstable"
RUST_LOG=debug,pilota_build=warn,salsa=warn,html5ever=warn,supervisor=warn,hyper=warn,rustls=warn,h2=warn,tower=warn,h3=warn,quinn_udp=warn,quinn_proto=warn,watchexec=warn,globset=warn,hickory_proto=warn,hickory_resolver=warn,aws_smithy_runtime=warn,aws_sdk_s3=warn,process_wrap=warn,tokio_postgres=warn,swc_ecma_transforms_base=warn,swc_timer=warn,swc_ecma_minifier=warn,swc_ecma_transforms_optimization=warn,fjall=warn,lsm_tree=warn,reqwest=warn,grep_regex=warn,cargo_machete=warn,fred=warn,ignored=warn,volo=warn,volo_=debug,volo_grpc=warn
RUST_BACKTRACE=short
set +a

env_sh() {
  local nowdir=$(pwd)
  cd "$(dirname $(realpath ${BASH_SOURCE[0]}))"/../conf/conn
  local i
  for i in $@; do
    set -o allexport
    source "$i".sh
    set +o allexport
  done

  cd $nowdir
  unset -f env_sh
}

#env_sh host kv gt redis mq pg mail clip nchan api qdrant
