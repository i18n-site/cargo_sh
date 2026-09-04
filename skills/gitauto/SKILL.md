---
name: gitauto
---

用 gh 查看 https://github.com/aembke/fred.rs/pulls 拉取请求

如果合理（这个要仔细确认），就合并过来

拉取请求，如果需求不合理，就不合并

并写一个日志记录下合并了的，这些都开子代理搞

每合并一个，就提交一次，尽量用 gh 的合并，有冲突再手动合并

最后推送，发布新版本

然后 gh 用英文回复请求，告诉它我的 fork 和 crate(因为原来的库感觉没人维护），已经合并了

https://github.com/webc-site/fredis
https://crates.io/crates/fredis

你要严格检查，code review，如果代码有问题，你也可以合并并调整，不好的拒绝