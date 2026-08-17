# 提权自动审批（AI 自动审核）

2026-08-17 迭代后的最终形态：**不做第四个权限模式**，而是在输入栏**权限选择器旁边**加一个独立的自动审批开关按钮（`conversation.input.left` 槽位，session 作用域）。开关与原生权限（只读 / 工作区写入 / 完全访问）**自由组合**：任何权限模式下开启开关，该会话的提权请求都会先经智谱**免费模型 GLM-4.7-Flash**（bigmodel.cn，OpenAI 兼容接口）自动审核，审查通过只放行**这一次**（`allowed-once`），不通过或拿不准再询问用户。**不改 harness 代码**。

## 机制

```
输入栏： [权限选择器] [✦ 自动审批开关] [Plan] ... [模型] [发送]
             ↑ 原生三模式           ↑ 本插件（conversation.input.left）
```

- **开关**：`src/client/AutoApproveToggle.tsx`，图标用内联的 `IconSparkle16`（自己的图标，无需上游）。开启时火花变绿色 + 浅绿底；按会话存储。
- **状态存储**：宿主插件维护 `$DSH_HOME/dsh-config/auto-approval.json`（`{ sessionId: boolean }`），通过 HTTP 路由 `/dsh-config/auto-approval`（GET 查询 / PUT 写入，`x-dsh-config: auto-approval` 请求头校验，session id 白名单校验）读写。不写会话日志（`KNOWN_SESSION_EVENT_TYPES` 是 harness 生成白名单，外部插件事件会破坏日志重建）。
- **审查器**：`approval/request` 瀑布流 `prepend: true`，排在 apiproxy 用户回答者之前：

```
提权请求 → ctx.approval.request({reason: "escalate sandbox to X: …"})
  → [本插件] 门槛 → 智谱审查 → ALLOW → "allowed-once"（只放行本次）
                            → 其他/失败/超时 → next() → [apiproxy] 弹窗问用户
```

## 门槛（任一不满足 → next() 交还用户）

- 该会话开关开启（`toggles.get(session.id) === true`）
- 是提权请求（`reason` 以 `escalate sandbox to` 开头）
- `config.allowDangerFullAccess`（默认 true）为 false 时 danger-full-access 目标一律交用户
- 能取到该次 `tool/call` 的参数（会话日志按 `callId` 配对）；取不到 → 交用户
- 危险命令黑名单命中（`rm -rf /`、`mkfs`、`dd`、fork 炸弹、curl|sh、git push --force 等）→ 直接交用户
- API Key 可解析（env `ZHIPU_API_KEY` → credentials `ZHIPU_API_KEY`）；无 Key 时开关不生效（提权照常询问）

## 配置入口

「设置 → 插件」的 `dsh-config-approval` 卡片（视觉对齐 dsh-vision：可折叠 PluginCard + 未保存徽标 + 放弃/保存 + 字段底部「前往 bigmodel.cn 获取免费 Key」链接）：只填智谱 API Key（写 credentials `ZHIPU_API_KEY`）。

## 文件

- `src/approval-review.ts` — 宿主插件（`dsh-config-approval-review`，inject `approval` + `webServer`）：审查器 + 开关路由。
- `src/client/AutoApproveToggle.tsx` — 输入栏开关按钮（`conversation.input.left`，id `dsh-config-auto-approve`，order 0）。
- `src/client/ApprovalReviewCard.tsx` — 配置卡片（`settings.plugin.item`）。
- `cordis.patch.yml` — 插件行（无预设补丁；权限选择器保持原生三个模式）。

## 生效说明

- 客户端（开关按钮、卡片）随 bundle 热更新，刷新即见。
- 宿主插件行是 bundle patch 新增，**需要重启 dsh web** 才挂载（路由 + 审查器）；重启后开关才真正生效。
- 审查记录：`$DSH_HOME/dsh-config/approval-review.jsonl`（JSONL，含会话、callId、目标模式、justification、结论、耗时）。
