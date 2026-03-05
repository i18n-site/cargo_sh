#!/usr/bin/env bun

/*
性能回归测试，保留512个历史数据
需要显示性能变化的百分比，好的变化百分比前面是+号，坏的变化百分比前面有-号
*/

import { i18nImport, benchJsonLi } from "./conf.js";
import table from "./table.js";
import conv from "./lib/conv.js";
import bench from "./lib/bench.js";

await bench();

const I18N = await i18nImport(import.meta);

await bench();

conv(benchJsonLi());

console.log(table());
