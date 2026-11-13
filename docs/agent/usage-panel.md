# Token 用量面板

> **2026-10-17 适配 dsh 0.2.0-rc.2**：记账来源由 `assistant/chunk`（usage 块）+ `assistant/message` 双路改为**仅 `assistant/message`**（0.2.0 usage 直接挂在事件数据上，chunk 事件已移除）；会话事件读取改用 `session.snapshotEvents()`。入口槽位（`sidebar.footer.action`）与界面不变。

dsh-config 在 DSH Web **侧边栏设置上方的「用量」入口**（`sidebar.footer.action`）中提供 Token 用量统计，点击打开自绘弹窗。历程：2026-08-17 先挂在「设置 → 插件」卡片，随后改为独立设置分区（`settings.section`），再按用户要求删除分区入口、只保留侧边栏按钮（设置导航图标是壳层硬编码的，外部插件换不了）。

## 数据

- 用量记录保存在 `$DSH_HOME/dsh-config/usage.json`（**v2 结构**：`days` 为按「自然日 ×（项目 × 模型）」提前聚合的桶（费用含峰谷拆分），`today` 仅保留当前自然日逐条明细，跨天自动折叠；v1 全量 `records` 首次加载时自动迁移为 v2）。
- `deepseek-official` 的 `deepseek-v4-flash` / `deepseek-v4-pro` 按官方峰谷单价计费。
- **美元牌价估算档（2026-11-13 起）**：`opencodex`、`openai-codex`、`github-copilot` 下的 claude / gpt / grok / kimi 系模型按各家 API 官方牌价**估算**费用——美元价 × 固定汇率 7.2 折人民币，单一价（峰谷规则不适用），费用字段为估算参考值。牌价（美元/百万词元：输入 / 缓存读 / 缓存写 / 输出；缓存写统一取短时效档，无缓存写牌价的按输入价计）：
  - Anthropic：`claude-opus-5-5` 4 / 0.20 / 5 / 20；`claude-sonnet-5` 2 / 0.20 / 2.50 / 10（github-copilot 与 opencodex/cursor 线路同价）
  - OpenAI：`gpt-5.6-luna` 0.20 / 0.02 / 0.25 / 1.20；`gpt-6-luna` 0.10 / 0.01 / 0.125 / 0.50；`gpt-5.6-terra` 2.00 / 0.20 / 2.50 / 12.00；`gpt-5.3-codex-spark` 按 `gpt-5.3-codex` 1.75 / 0.175 / 1.75 / 14.00（官方无 spark 条目）
  - xAI（<200k prompt 档，DSH 单请求几乎不超 200k，统一用此档）：`grok-4.7` 2.00 / 0.50 / 2.00 / 6.00；`grok-4.7--fast`（Cursor fast 变体，标准价 2 倍）4.00 / 1.00 / 4.00 / 12.00
  - Kimi（Moonshot 官方）：`kimi-k3` 3.00 / 0.30 / 3.00 / 15.00（缓存写价未公布，按输入价，与 zai 口径一致）
  - 无牌价记 0 清单：`opencodex/nvidia/deepseek-ai-deepseek-v4.1-flash`、`opencodex/cloudflare-workers-ai/@cf-deepseek-ai-deepseek-v4.1-flash-1017` 等未收录模型（历史调用量个位数）。
- `zai-coding-cn`（GLM Coding Plan 包月套餐）按**智谱国内站 API 统一牌价估算**费用（2026-10-17 起计价；此前该供应商记 0，历史聚合不回填）：`glm-5.3-flash` 0.23/0.8/2.8、`glm-5.3-flashx` 0.57/2/7、`glm-5.3` 与 `glm-5.2` 2/8/28、`glm-5.1` 1.3/6/24、`glm-5-turbo` 1.2/5/22、`glm-5` 1/4/18（元/百万词元，缓存命中/未命中输入/输出）。**智谱无峰谷差价**（谷时半价是 DeepSeek 的结构；智谱的「错峰」是套餐额度活动，不影响 API 单价），峰/闲拆分按调用发生时段归属；分档模型按低档计；未知 GLM 模型记 0。
- 其余订阅档（`opencode-free` 及同类免费/token-plan）费用记 0，只统计词元量；筛选标签为 `provider/model`（opencodex 为三段复合名，如 `opencodex/anthropic/claude-opus-5-5`）。
- `opencodex` 2026-11-13 起纳入记账（此前该供应商所有事件被白名单丢弃，属漏记缺陷）；历史漏记部分由 `scripts/backfill-usage.mjs` 回填——脚本扫描近 30 天会话日志，按现行计价与去重规则重建记录，与存量按「天 × 模型」算差额后幂等折叠写入（自动备份、不动 today 明细）。宿主侧白名单需重启 dsh 才生效；回填必须在**停机窗口**一次跑齐——宿主运行中会把内存里的旧状态全量写回覆盖外部修改，启动后再跑脚本要么无事可做要么有害。
- 缓存写入按缓存未命中输入计费。
- 记录以 `sessionId:turn:step` 去重；0.2.0 起 usage 直接挂在 `assistant/message` 事件数据上，逐条各记一条。
- 前端每 15 秒轮询 `/dsh-config/usage` 刷新（该接口要求 `x-dsh-config: usage-calendar` 请求头）。

## 计费（2026-08-17 生效）

DeepSeek 官方 2026-08-17 起改用峰谷计价：高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为闲时，闲时价格为高峰的一半（元 / 百万 tokens）：

| 模型              | 缓存命中 高峰 / 闲时 | 未命中输入 高峰 / 闲时 | 输出 高峰 / 闲时 |
| ----------------- | -------------------- | ---------------------- | ---------------- |
| deepseek-v4-flash | 0.10 / 0.05          | 3.0 / 1.5              | 9.0 / 4.5        |
| deepseek-v4-pro   | 0.30 / 0.15          | 9.0 / 4.5              | 27.0 / 13.5      |

前端 `isPeak()` 用 UTC+8（北京时区无夏令时）判定记录时间是否落在高峰窗口，每条记录按自身发生时间取对应单价；「实际费用」卡片同时展示高峰 / 闲时费用拆分。

## 实现

- Host 半侧：`src/usage-api.ts`（记账 + `/dsh-config/usage` 只读接口）。
- 浏览器半侧：`src/client/index.ts`（分区 + 侧边栏入口注册）与 `src/client/UsageSection.tsx`（面板 UI）。
- 入口：注册 `sidebar.footer.action`（id `usage`、order 0），在**设置入口上方**渲染自带图标的「用量」按钮（宽栏图标+文字、窄栏圆形图标，样式逐项对齐设置触发器 `.trigger`），点击打开自绘弹窗（`src/client/UsageTrigger.tsx`，外壳逐项对齐设置弹窗 SettingsRoot：`bg-layer-2`、无边框、lv3 阴影、54px 顶栏、官方关闭按钮）。图标由插件自己控制，不依赖壳层按 id 硬编码的图标映射。
- 图标：`src/client/icons.tsx` 从 `@deepseek-ai/dsh-client-ui-primitives`（`src/icons`，ic*ds*\* 字形）**内联**了 5 个 SVG。不直接 import 该包：其已发布 lib 没有 icons-only 子入口，根入口会连带 markdown/katex 图（含 `katex.min.css` 实引），tsdown 无法打包（需 `@tsdown/css`），且 `treeshake: { moduleSideEffects: false }` 挡不住 css-guard 的加载。

## 界面（2026-08-17 重做，参考 Codex 用量页）

- 顶部 5 个指标卡：累计 Token 数 / 单日峰值 Token / 累计费用 / 当前连续天数 / 最长连续天数（连续天数按本地日聚合，截至最近有记录的一天）。
- 「Token 活动」卡片内 GitHub 式热力图，按 token 量分 5 级着色（0 级为 `--dsw-alias-bg-layer-2`，1-4 级把 `--dsw-alias-state-success-primary` 混入，随主题自适应）：
  - 每日：一年 52 周 × 7 天，列向铺满整行（flex 拉伸，格约 11px 见方），左侧一~日全星期标签，下方月份标签（某月的 1 号落在哪一周就在哪一列标注，百分比定位）。
  - 每周：16 周分 4 列 × 4 行、每列纵向堆叠 4 周，列向铺满宽度（宽条），下方每列标注月份。
  - 每月：12 个月 6×2，26px 色块，块下标注月份。
  - 未来日期与无记录色块不可点击（半透明）。
- 点击色块：下方四张汇总大字卡（费用 / Token 总数 / 输入输出 / 缓存命中）同步切换为该日 / 周 / 月的数据，上方显示「X 合计 + 取消选择」；选中块带蓝色描边。切换视图/筛选清除选中。
- **筛选组合**：项目 + 模型两个下拉可同时生效（AND 组合），作用于指标卡、三种视图的热力图、区间汇总与点击明细——全部由同一 `filtered` 派生，天然组合。
- 底部保留区间汇总卡（费用 / Token 总数 / 输入输出 / 缓存命中）与峰谷计费说明。

## 构建

```sh
pnpm install
pnpm run build   # 生成 lib/（Host ESM + 浏览器 client.js）
pnpm run check   # tsc --noEmit
```

web profile 通过 `link:` 安装本 checkout；重建 `lib/client.js` 后刷新页面即可生效（bundle 按请求从磁盘读取，无需重启服务）。
