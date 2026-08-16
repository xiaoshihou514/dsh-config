# dsh-config

个人 DeepSeek Harness 配置包。

## Token 用量日历

在 DSH Web 的“设置 → 插件”中显示 Token 用量日历。它会按日、周或月聚合 DeepSeek 官方模型的调用，并可按项目筛选输入、输出、缓存读写、调用次数和人民币费用。

用量记录保存在 `$DSH_HOME/dsh-config/usage.json`，重启后仍可查看。当前只统计 `deepseek-official` 的 `deepseek-v4-flash` 和 `deepseek-v4-pro`；缓存写入按缓存未命中输入计费。

```sh
just install
```
