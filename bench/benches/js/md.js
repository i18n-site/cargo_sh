#!/usr/bin/env bun

/*
生成性能测试 markdown 图表，以方便嵌入 readme
*/

import md from "./lib/md.js";
import CONV from "./CONV.js";
import { MARKDOWN_BORDER } from "@visulima/tabular/style";
import { createTable } from "@visulima/tabular";

await md((I18N) => {
  const table = createTable({
    showHeader: true,
    style: {
      border: MARKDOWN_BORDER,
    },
  });

  table.setHeaders([]);

  Object.entries(CONV).forEach(([k, v]) => {
    table.addRow([]);
  });

  return table.toString();
});
