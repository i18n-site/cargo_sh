#!/usr/bin/env bun

import { benchJsonLi } from "./conf.js";
import conv from "./lib/conv.js";

export default conv(benchJsonLi());
