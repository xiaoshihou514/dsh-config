# 智能体办公室

Agent Teams 的 3D 可视化。会话头部「办公室」按钮（团队插件启用时显示）打开全屏弹窗。

## 结构

| 文件 | 职责 |
|---|---|
| `src/agent-office.ts` | 宿主插件：`GET /dsh-config/office?lead=`（需 `x-dsh-config: agent-office`，带 ETag）与 `GET /dsh-config/office/scene.js` |
| `src/office/derive.ts` | 纯推导：会话事件 → 成员活动、当前动作、交流、任务（有单测） |
| `src/office/classify.ts` | 模型 → 厂商 / 档位，名字 + 描述 → 岗位；改档位规则看 `FAST_PATTERNS` / `FLAGSHIP_PATTERNS` |
| `src/office-scene/` | three.js 场景（独立 ESM `lib/office-scene.js`，打开弹窗时才加载） |
| `src/client/OfficeAction.tsx` | 头部按钮、弹窗、成员详情与交流动态面板 |

## 数据来源

- 名册：Lead 会话的 `team/member`；任务：`team/task`，没有则用 Lead 的 `todo/write`。
- 交流：接收方日志里的 `agent-message`（成员消息）、`subagent-settled`（完工汇报）、子会话首条用户消息（招募）、Lead 的用户消息（你的指令）。
- 活动：`tool/call` / `tool/result` / `assistant/message`；已加载会话读内存，未加载的读持久化存储（按存储版本缓存）。
- 是否在跑：以浏览器会话状态为准，宿主推导（已加载且有未结束步骤）兜底。

## 角色

- 角色图鉴：点击角色进入细看（放大、自动旋转，可切正 / 斜侧 / 侧 / 背角度与站立、走路、打字、思考、等待、沟通、休息动作，← → 切换，Esc 返回）。
- 人设调色与特征见 `src/office-scene/personas.ts`，未知模型为兜帽旅人。
- 快速档是缩小 0.8 的简装版（短发、短裙），刘海带黄色闪电发夹。
- 岗位：左臂袖章与胸章颜色、右手道具、工位摆设（后端服务器机箱、测试虫罐、审查稿纸…）；组长头顶金星、独立玻璃办公室。

## 自查

- 有三视图的厂商（`../人设/体素/<厂商>.png`）：`scripts/voxelize-personas.py` 按 DeepSeek 图的像素格（14px）切网格，生成 `src/office-scene/sprites.generated.ts`；`sprite-character.ts` 逐行推算截面（每段宽取正视图、深取侧视图的超椭圆，窄段按自身宽度收深度），按侧视图挖空；颜色按平滑法线分区（朝前取正视图、朝后取背视图、朝侧取侧视图），侧视图颜色只采用正 / 背视图附近出现过的（否则换成最接近的），头部前段侧面用相邻鬓发色。关节：头、上身、下身、左右腿（手臂未拆）。换图后重跑脚本再构建。
- 没有三视图的厂商（目前只有未知模型）回退到网格角色（`anime.ts`）。岗位道具与星标等小件是体素（`props.ts`）。
