---
name: clippy
---

1. 运行 ./sh/clippy.sh ，按 rust 的方式对程序进行优化，并清理不用的死代码，避免警告

2. `rg "\[allow" -t rs`，删除 allow，用 rust 的方式，改写

3. 运行 ./sh/clippy.sh 复查