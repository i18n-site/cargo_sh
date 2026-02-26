#!/usr/bin/env bun

import { BENCH_JSON_PATH, PWD } from "../conf.js";
import { $, cd } from "zx";

$.verbose = true;

cd(PWD);

export default (features = "bench") =>
  $`cargo criterion --bench main --message-format=json --features ${features} > ${BENCH_JSON_PATH}`;
