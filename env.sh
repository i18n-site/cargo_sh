#!/usr/bin/env bash

set -a
RUSTFLAGS="$RUSTFLAGS --cfg reqwest_unstable"
RUST_LOG=debug,quinn=warn,ureq=warn,ureq_proto=warn,pilota_build=warn,salsa=warn,html5ever=warn,supervisor=warn,hyper=warn,rustls=warn,h2=warn,tower=warn,h3=warn,quinn_udp=warn,quinn_proto=warn,watchexec=warn,globset=warn,hickory_proto=warn,hickory_resolver=warn,aws_smithy_runtime=warn,aws_sdk_s3=warn,process_wrap=warn,tokio_postgres=warn,swc_ecma_transforms_base=warn,swc_timer=warn,swc_ecma_minifier=warn,swc_ecma_transforms_optimization=warn,fjall=warn,lsm_tree=warn,reqwest=warn,grep_regex=warn,cargo_machete=warn,fred=warn,ignored=warn,volo=warn,volo_=debug,volo_grpc=warn,volo_http=warn
RUST_BACKTRACE=short
set +a

if [ -f "./.env.sh" ]; then
  . ./.env.sh
fi
