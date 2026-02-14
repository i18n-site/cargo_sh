#!/usr/bin/env bun

/*
格式，BENCH_LI
用于展示性能测试结果，按性能优劣排序(不同字段可能顺序不一样)
以最低为基准 1
输出格式如：
指标（单位，如果性能比较高，用百万作为单位，保留2位小数）
  库1: 实测性能 ( 倍数x )
  库2: 实测性能 ( 倍数x )
  库3: 实测性能 ( 1x )
*/

import { i18nImport } from "./conf.js";
import { createTable } from "@visulima/tabular";
import { NO_BORDER } from "@visulima/tabular/style";
import CONV from "./CONV.js";

const gen = async () => {
  const I18N = await i18nImport(import.meta),
    table = createTable({
      showHeader: true,
      style: {
        paddingLeft: 0,
        border: NO_BORDER,
      },
    });
  table.setHeaders([I18N.XX, I18N.XX]);

  Object.entries(CONV).forEach((json) => {
    console.log(json);
    // table.addRow(["X1", "X2"]);
  });

  console.log(table.toString());
};

export default gen;

if (import.meta.main) {
  await gen();
}
