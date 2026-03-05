rust 项目创建性能评测步骤

1. 安装依赖，基于 criterion 开发测试

cargo add --dev criterion tikv-jemallocator humansize

2. 设计评测指标

在评测目录 benches/base.rs，定义 trait，所有参与评测的库都实现这个 trait （如果已经有共同的 trait，可以这一步）

评测基于 trait 进行，trait 有 const NAME: &str; 评测 id 基于 NAME 生成

3. 配合 trait 创建评测框架

评测框架用 benches/main.rs 表示主测试文件

4. cargo add --dev 对比的依赖库 ，也添加到评测

5. 在./Cargo.toml 添加特性 bench-库名 可以单独评测某个库

然后，特性 bench 会包含所有库的 bench，用来评测所有库的性能

7. 运行测试和 ../sh/clippy.sh，修复错误和报警

8. 运行和 crate src 同级目录的 ./bench.js（ 禁止修改这个文件），生成测试 json

9. 修改 ./benches/js 下面的脚本，适配当前框架的测试的指标设计

脚本已经演示了如何加载 ./benches/js/ 语言名/文件名.js 中的语言文件

请尊重现有代码的各种写法，在其基础上二次开发，不要直接覆盖重写，注意如下:

9.1 不要改变 I18N 的加载方式 ( ./benches/js/i18n 请完善具体的语言文件，让内容支持英文和中文 )
9.2 代码中导入了基础库，注释写了文件应该干什么，请按照文件中指示基于引用库开发，不要乱搞，不要删除指示和引用库
9.3 benches/js/i18n/ 语言/ 下面的 js 内部定义语言字符串，不要用字典，用 export const 大写的变量名
9.4 md.js 如果要加载文件，可以用 conf.js 的 i18nRead
9.5
请保留 js 脚本开头的 `#! /usr/bin/env bun` 和可执行权限
如果缺少依赖库，直接用 bun i 安装
9.6 需要执行 bash 的地方，用 zx 库
9.7 注意代码复用，公用的部分，比如解析转换 json，可以创建库到 benches/js/lib.js
    js 的写法如下，用最现代的 nodejs 写法
    如果有多个 const，尽量合并用为一个 const 声明，变量 let 声明同理
    命名要极简，命名法风格:变量名:下划线风格，函数名:小写驼峰风格，全局常量:大写
    函数用 const funcname = ()=>{} 这种格式来定义, 不要用 function 定义函数
    用 await 不要用 .then
    写纯函数，不要写类
    加密和解密用 Web Crypto API
    二进制数据尽量用 Uint8Array
    js 文件默认导出都写 default
    网络请求直接用原生的 fetch ( 不要用 node-fetch )
    不要处理异常,不要写 try catch
    用 import.meta.dirname 获取当前目录
    不要写函数注释
    import 导入函数，避免直接导入模块
9.8 不要写 console.log 输出进度什么的无用信息，只输出核心信息，多用多行字符串
9.9 table.js md.js svg.js 写完之后可以直接运行排除错误，不要反复运行速度很慢的 bench.js

10. 运行 oxfmt 格式化 js ， 运行 oxlint 检查，并修复错误

11. 再次运行 ./bench.js ，生成最终的结果