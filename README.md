# dsh-config

个人dsh配置

- 词元用量统计
- DeepSeek、智谱用量
- opencode 免费模型接入（在原生模型选择器里只列 `*-free`；自动拉起/复用
  `opencode serve`，密码与端口由插件管理；限流时按延迟自动切换 Clash 出口节点）
- 提示词备忘录
- 上下文溢出自动压缩
- 哔哩哔哩技能

## opencode 限流换节点

免费模型返回 `provider.free-limit` / `provider.rate-limit`（429）时，会从
opencode.ai 当前实际经过的 Clash 代理组里按延迟选一个最快的其他节点切过去，
然后重发这一轮；已经输出过内容时不重发，只让下一轮换出口。

默认自动探测 Clash Verge 的 unix socket
（`/run/clash-verge-service/users/<uid>/verge-mihomo.sock`）和
`127.0.0.1:9090`，探测不到就静默跳过。需要时可在 profile 配置里覆盖
`clashEnabled` / `clashApi` / `clashSecret` / `clashGroup` / `clashTestUrl` /
`clashTimeoutMs` / `clashCooldownMs` / `clashAvoidRecent` / `limitRetries`，
或用环境变量 `DSH_CLASH_DISABLE=1`、`DSH_CLASH_API`、`DSH_CLASH_GROUP`
临时调整。
