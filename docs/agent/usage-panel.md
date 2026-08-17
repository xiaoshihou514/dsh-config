# Token 用量面板

dsh-config 在 DSH Web **侧边栏设置上方的「用量」入口**（`sidebar.footer.action`）中提供 Token 用量统计，点击打开自绘弹窗。历程：2026-08-17 先挂在「设置 → 插件」卡片，随后改为独立设置分区（`settings.section`），再按用户要求删除分区入口、只保留侧边栏按钮（设置导航图标是壳层硬编码的，外部插件换不了）。

## 数据

- 用量记录保存在 `$DSH_HOME/dsh-config/usage.json`（`version: 1`）。
- 只统计 `deepseek-official` 提供商的 `deepseek-v4-flash` / `deepseek-v4-pro`。
- 缓存写入按缓存未命中输入计费。
- 记录以 `sessionId:turn:step` 去重；`assistant/chunk`（usage 块）或 `assistant/message`（带 usage）各记一条。
- 前端每 15 秒轮询 `/dsh-config/usage` 刷新（该接口要求 `x-dsh-config: usage-calendar` 请求头）。

## 计费（2026-08-17 生效）

DeepSeek 官方 2026-08-17 起改用峰谷计价：高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为闲时，闲时价格为高峰的一半（元 / 百万 tokens）：

| 模型 | 缓存命中 高峰 / 闲时 | 未命中输入 高峰 / 闲时 | 输出 高峰 / 闲时 |
| --- | --- | --- | --- |
| deepseek-v4-flash | 0.10 / 0.05 | 3.0 / 1.5 | 9.0 / 4.5 |
| deepseek-v4-pro | 0.30 / 0.15 | 9.0 / 4.5 | 27.0 / 13.5 |

前端 `isPeak()` 用 UTC+8（北京时区无夏令时）判定记录时间是否落在高峰窗口，每条记录按自身发生时间取对应单价；「实际费用」卡片同时展示高峰 / 闲时费用拆分。

## 实现

- Host 半侧：`src/usage-api.ts`（记账 + `/dsh-config/usage` 只读接口）。
- 浏览器半侧：`src/client/index.ts`（分区 + 侧边栏入口注册）与 `src/client/UsageSection.tsx`（面板 UI）。
- 入口：注册 `sidebar.footer.action`（id `usage`、order 0），在**设置入口上方**渲染自带图标的「用量」按钮（宽栏图标+文字、窄栏圆形图标，样式逐项对齐设置触发器 `.trigger`），点击打开自绘弹窗（`src/client/UsageTrigger.tsx`，外壳逐项对齐设置弹窗 SettingsRoot：`bg-layer-2`、无边框、lv3 阴影、54px 顶栏、官方关闭按钮）。图标由插件自己控制，不依赖壳层按 id 硬编码的图标映射。
- 图标：`src/client/icons.tsx` 从 `@deepseek-ai/dsh-client-ui-primitives`（`src/icons`，ic_ds_* 字形）**内联**了 5 个 SVG。不直接 import 该包：其已发布 lib 没有 icons-only 子入口，根入口会连带 markdown/katex 图（含 `katex.min.css` 实引），tsdown 无法打包（需 `@tsdown/css`），且 `treeshake: { moduleSideEffects: false }` 挡不住 css-guard 的加载。

## 界面（2026-08-17 重做，参考 Codex 用量页）

- 顶部 5 个指标卡：累计 Token 数 / 单日峰值 Token / 累计费用 / 当前连续天数 / 最长连续天数（连续天数按本地日聚合，截至最近有记录的一天）。
- 「Token 活动」卡片内 GitHub 式热力图，按 token 量分 5 级着色（0 级为 `--dsw-alias-bg-layer-2`，1-4 级把 `--dsw-alias-state-success-primary` 混入，随主题自适应）：
  - 每日：一年 52 周 × 7 天，列向铺满整行（flex 拉伸，格约 11px 见方），左侧一~日全星期标签，下方月份标签（某月的 1 号落在哪一周就在哪一列标注，百分比定位）。
  - 每周：16 周分 4 列 × 4 行、每列纵向堆叠 4 周，列向铺满宽度（宽条），下方每列标注月份。
  - 每月：12 个月 6×2，26px 色块，块下标注月份。
  - 未来日期与无记录色块不可点击（半透明）。
- 点击色块弹出该日 / 周 / 月的各项目用量表（项目、调用、Token、费用 + 合计），附高峰 / 闲时费用拆分；「取消选择」或切换视图/筛选清除选中。
- **筛选组合**：项目 + 模型两个下拉可同时生效（AND 组合），作用于指标卡、三种视图的热力图、区间汇总与点击明细——全部由同一 `filtered` 派生，天然组合。
- 底部保留区间汇总卡（费用 / Token 总数 / 输入输出 / 缓存命中）与峰谷计费说明。

## 构建

```sh
pnpm install
pnpm run build   # 生成 lib/（Host ESM + 浏览器 client.js）
pnpm run check   # tsc --noEmit
```

web profile 通过 `link:` 安装本 checkout；重建 `lib/client.js` 后刷新页面即可生效（bundle 按请求从磁盘读取，无需重启服务）。
