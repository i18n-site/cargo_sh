#!/usr/bin/env bun

/*
生成性能测试柱状图 svg， 每个库用一个颜色的图例，每张图性能最好的库上方添加红色的五角星
*/

import CONV from "./CONV.js";
import { readmeWrite } from "./conf.js";
import svgo from "@3-/svgo";
import { init } from "echarts";

const gen = () => {
  return Promise.all(
    readmeWrite(import.meta, "bench.svg", (I18N) => {
      // 用垂直布局，每个指标一张图
      const chart = init(null, null, {
        renderer: "svg",
        ssr: true,
        width: 0, // todo width
        height: 0, // todo height
      });

      Object.entries(CONV).forEach((json) => {
        // todo gen chart
      });

      chart.dispose();
      return svgo(chart.renderToSVGString());
    }),
  );
};

export default gen;

if (import.meta.main) {
  await gen();
}
