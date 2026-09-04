执行优化建议
先拆分执行计划，
每个执行计划按下面的流程来执行:
1. git add . && git commit -m 提交注释 && git tag xxx_begin
2. 修改代码
3. ./test.sh
4. 调试
   - 如调试成功，git add . && git commit -m 提交注释 && git tag xxx_end
   - 如调试失败，git add . && git commit -m 提交注释 && git tag xxx_failed ；然后回滚到 xxx_begin