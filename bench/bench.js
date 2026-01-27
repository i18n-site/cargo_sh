#!/usr/bin/env bun

import bench from "./benches/js/lib/bench.js";
import table from "./benches/js/table.js";
import svg from "./benches/js/svg.js";

await bench();
await table();
await svg();
