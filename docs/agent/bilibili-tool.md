# B 站内容理解与下载工具（dsh-config-bilibili）

把 `../bilibili-video-downloader`（Tauri 应用：Rust 后端 ~13K 行 + Vue GUI）内联进 dsh-config，用 TypeScript 重写后端逻辑，以 **DSH 模型工具（`bili_*`）** 形式暴露给智能体。

## 1. 定稿范围（与用户确认）

- **纯 agent 工具**：不暴露任何用户界面（无 React 卡、无 webServer 路由、无设置页）。
- **不做视频下载**。`bili_download` 把产物**下载到本地 `downloadDir`**（默认 `~/Downloads/bilibili`）并在返回里给出 `targetPath`：**音频**（m4a / flac / 杜比）、**封面**、**字幕**、**弹幕**、**元信息**（json / nfo）。
- **核心目标是智能体理解**：agent 关键词搜索、按 URL/ID 解析详情后，用 `bili_download` 把音频/字幕/弹幕**落到本地磁盘**，再用自身 fs 工具读字幕/弹幕文件、对本地音频跑转文字（ASR），从而"看懂"B 站视频内容。
- **ffmpeg 只用系统**（`ffmpegPath` 配置，默认 `ffmpeg` 走 PATH）。音频为单文件直下载，通常不需要 ffmpeg；该配置位仅为将来转码预留。

## 2. 非目标（明确不做）

- 视频流下载、音视频合并、章节/广告标记嵌入（没有视频文件）。
- 多分片并发下载、断点续传状态机（音频/封面/字幕文件小，单流下载足够；任务进度保留简单轮询）。
- 二维码登录：**不做**（按用户决定，2026-08-20）；登录态只走 `sessdata` 配置。依赖登录的用户内容（收藏/历史/稍后再看/追番，`api/user.ts`）一并搁置。
- Vue GUI 的还原（搜索列表、下载面板、设置弹窗等一律不迁移）。

## 3. 总体架构

```
dsh-config/
├── package.json          + exports "./bilibili" → lib/bilibili.js
│                         + devDependencies "@deepseek-ai/dsh-tools"
├── cordis.patch.yml      + 一行 dsh-config-bilibili
├── tsdown.config.ts      + entry bilibili: "src/bilibili/index.ts"（node 平台）
└── src/bilibili/
    ├── index.ts          插件入口（name / inject / Config / apply）
    ├── settings.ts       schemastery Config（cordis.yml 可配，无 UI）
    ├── http.ts           fetch 封装：UA / Referer / cookie / 重试 / BiliResp 校验 / 代理
    ├── wbi.ts            WBI 签名（纯函数，可单测）
    ├── types.ts          响应类型（Rust serde 结构 → TS interface，见 §4.5）
    ├── api/
    │   ├── nav.ts        登录态 + WBI keys
    │   ├── view.ts       普通 / 番剧 / 课程 / UP 空间 信息解析（原版 get_*_info 移植）
    │   ├── search.ts     关键词搜索（**新增能力**，原版无）
    │   ├── player.ts     字幕列表（/x/player/wbi/v2）+ 标签
    │   ├── playurl.ts    playurl 三系，只取音频流（fnval=4048 的 dash.audio / flac / dolby）
    │   └── user.ts       （搁置）收藏 / 历史 / 稍后再看 / 追番——依赖登录，未做
    ├── download/
    │   ├── manager.ts    任务注册表 + 并发限制 + 状态轮询
    │   ├── task.ts       单流下载任务（进度 / 取消 / 错误）
    │   ├── naming.ts     目录 / 文件命名模板（原版 dir_fmt 移植）
    │   └── meta.ts       json 元信息 / nfo / 封面落盘
    └── tools/
        ├── bili_search.ts
        ├── bili_video_info.ts
        ├── bili_download.ts
        ├── bili_download_status.ts
        └── bili_download_control.ts
```

分层职责（对齐原版 Rust 模块）：

| dsh-config 模块 | 原版 Rust 对应 | 说明 |
| --------------- | -------------- | ---- |
| `http.ts` + `wbi.ts` | `bili_client.rs`（client 部分）+ `wbi.rs` | UA `Chrome/136` 同款、Referer `https://www.bilibili.com/`、WBI 签名逐字移植 |
| `api/view.ts` | `commands.rs::search` + `bili_client.rs` get_*_info | 原版"搜索"= URL/ID 解析，照搬 |
| `api/search.ts` | （无） | 新增 B 站关键词搜索，服务智能体理解 |
| `api/player.ts` | `get_player_info` / `get_subtitle` | CC 字幕列表 + 字幕内容 |
| `api/playurl.ts` | `get_normal/bangumi/cheese_media_url` | 只消费 dash 的音频轨 |
| `download/*` | `downloader/*`（download_manager / download_task / download_chunk_task） | 多分片→单流，去掉信号量分片与状态机，保留进度与取消 |
| `download/naming.ts` | `config.rs` dir_fmt + `utils.rs filename_filter` | 命名模板与非法字符过滤逐字移植 |
| `download/meta.ts` | `tasks/nfo_task.rs` / `json_task.rs` / `cover_task.rs` | 元信息 / 封面 |
| `tools/*` | （无） | DSH 工具面，全新 |

### 接入点（实现阶段改动，设计确认后再动）

1. `package.json`：`exports` 加 `"./bilibili"`；devDependencies 加 `"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"`（与现有 `@deepseek-ai/*` 同版本线；当前 node_modules 里没有 dsh-tools，需新增）。
2. `cordis.patch.yml`：`insert` 列表加一行 `- id: dsh-config-bilibili`。
3. `tsdown.config.ts`：node 入口组加 `bilibili: "src/bilibili/index.ts"`。
4. `src/bilibili/index.ts`：`export const name = "dsh-config-bilibili"`、`export const inject = ["tools"]`、`export const Config`（schemastery）、`apply(ctx, config)` 里 `ctx.tools.register(defineTool(...))` 每个工具。

## 4. 模块设计

### 4.1 `http.ts` — 请求封装

- 全局 `fetch`（Node 22 自带），封装：
  - 固定 `User-Agent`（与原版一致）与 `Referer`。
  - `Cookie: SESSDATA=...`（有配置才带；另带 `buvid3`/`b_nut` 等基础 cookie 减少风控）。
  - 超时（`AbortSignal.timeout`）+ 瞬态重试（网络错误 / 5xx，指数退避，默认 2 次）。
  - `BiliResp { code, message, data }` 校验：`code !== 0` 抛 `BiliError`（携带 code 与 message）。
  - 代理：暂不实现（无代理需求；将来需要时经 `undici` `ProxyAgent` 引入并记为依赖）。
- 接口：`getJson<T>(path, params, opts)` / `getBuffer(url, range?)` / `getText(url)`。

### 4.2 `wbi.ts` — WBI 签名（逐字移植 `wbi.rs`）

- `MIXIN_KEY_ENC_TAB` 64 元素常量表照抄。
- `getWbiKeys()`：`/x/web-interface/nav` 的 `data.wbi_img.img_url/sub_url` 取文件名（去扩展名）。
- `sign(params)`：加 `wts` 时间戳 → 按键排序 → `get_url_encoded`（RFC3986 精简版，逐字移植）→ MD5(query + mixin_key) → 加 `w_rid`。
- keys 缓存 + 失败降级：nav 拿不到时允许不带签名请求（部分接口可匿名访问）。
- 纯函数，单测覆盖：给定 keys 与参数断言签名结果（与 Rust 版对拍）。

### 4.3 `settings.ts` — Config（schemastery，cordis.yml 可配）

```ts
export interface Config {
  sessdata?: string;          // 登录态；留空则匿名（画质/音频受限，-352 风控概率高）
  downloadDir: string;        // 默认 ~/Downloads/bilibili
  audioQuality: string;       // 64K | 132K | 192K | Dolby | HiRes（默认 192K，优先取可用）
  downloadArtifacts: {        // bili_download 省略 artifact 时下载什么，默认全开
    audio: boolean; cover: boolean; subtitle: boolean; danmaku: boolean; json: boolean; nfo: boolean;
  };
  namingTemplate: string;     // 默认 "{title}/{bvid}_{part}"，令牌：{title}{bvid}{part}{pubdate}{up}
  concurrency: number;        // 并发下载任务数，默认 2
  requestIntervalMs: number;  // 请求间隔，默认 200（风控友好）
  ffmpegPath: string;         // 默认 "ffmpeg"（预留，当前无调用点）
}
```

### 4.4 `api/` — 端点表（全部来自原版 `bili_client.rs`，除标注外）

| 能力 | 端点 | WBI | 登录 | 用途 |
| ---- | ---- | --- | ---- | ---- |
| 登录态 + WBI keys | `GET /x/web-interface/nav` | 否 | 可选 | keys + 登录判定 |
| 普通视频信息 | `GET /x/web-interface/view?bvid=\|aid=` | 否 | 否 | bvid/av/URL 解析 |
| 番剧信息 | `GET /pgc/view/web/season?ep_id=\|season_id=` | 否 | 否 | ep/ss 解析 |
| 课程信息 | `GET /pugv/view/web/season?ep_id=\|season_id=` | 否 | 否 | ep/ss 解析 |
| UP 投稿 | `GET /x/space/wbi/arc/search?mid=&page=` | 是 | 否 | uid 解析 |
| **关键词搜索** | `GET /x/web-interface/wbi/search/type?search_type=&keyword=&page=` | 是 | 否 | 新增 |
| 字幕列表 + skip | `GET /x/player/wbi/v2?bvid=&cid=` | 是 | 否 | 字幕列表（`subtitle.subtitles[].subtitle_url`） |
| 字幕内容 | `GET {subtitle_url}` | 否 | 否 | json body（`body[]`：from/dur/content） |
| 弹幕 | `GET /x/v1/dm/list.so?oid={cid}` | 否 | 否 | gzip XML（免 protobuf，见 §5） |
| 标签 | `GET /x/web-interface/view/detail/tag?bvid=&cid=` | 否 | 否 | tags |
| 音频流 | `GET /x/player/wbi/playurl?bvid=&cid=&qn=127&fnval=4048` | 是 | 否 | dash.audio / flac / dolby |
| 番剧音频流 | `GET /pgc/player/web/v2/playurl?...` | 否 | 否 | 同上 |
| 课程音频流 | `GET /pugv/player/web/playurl?...` | 否 | 否 | 同上 |
| （搁置）收藏/历史/稍后再看/追番 | `/x/v3/fav/...` `/x/v2/history/toview` `/x/web-interface/history/search` `/x/space/bangumi/follow/list` | 部分 | **是** | 用户内容（依赖登录，未做） |
| （搁置）二维码登录 | `POST /x/passport-login/web/qrcode/generate` + `GET .../poll` | 否 | — | 未做 |

### 4.5 `types.ts` — 响应类型

- 把 Rust `types/` 里用到的 serde 结构翻译成 TS interface：`NormalInfo`（view）、`BangumiInfo`/`CheeseInfo`、`UserVideoInfo`、`NormalMediaUrl`（只保留 dash/audio/flac/dolby 相关字段）、`PlayerInfo`（字幕列表）、`Subtitle`、`Tags`、`SearchResult`。
- 未知字段一律 `unknown` 容忍，解析只取需要字段，避免整结构强校验（B 站字段会变）。

### 4.6 `download/` — 单流下载器

- `task.ts`：一个下载 = 一个 `DownloadTask`：`{ id, kind, title, state, bytesTotal?, bytesDone, targetPath?, error? }`。`state`：`queued → downloading → done | error`，可 `cancel`。
- **落盘本地**：产物一律下载到配置的 `downloadDir`；目标路径由 `naming.ts` 在**入队时即可确定**（命名是 `target` + `artifact` + 模板的确定性函数），所以 `bili_download` 返回里直接带 `targetPath`，不需要等任务完成。
- 流式写盘：`fetch(url, { signal, headers: Range? })` → `response.body`（web stream）管道到 `fs.createWriteStream`；进度按 `content-length` 与累计字节计算。
- `manager.ts`：内存注册表 + 磁盘任务 JSON（`$DSH_HOME/dsh-config/bilibili-tasks/*.json`，对齐原版 task_dir 语义，宿主重启后 `restore()`）；`concurrency` 信号量（简单计数即可，不引入依赖）；每个任务一个 `AbortController`。
- `naming.ts`：`filename_filter`（`\ / \n` → 空格、`:` → `：`、`*` → `⭐`、`?` → `？`、`"` → `'`、`< >` → `《 》`、`|` → `丨`，去首尾空格与句号）逐字移植；命名模板 `{title}/{bvid}_{part}` 渲染。
- `meta.ts`：`{...info}.json` 元信息、封面（`pic` 字段原图 URL）、nfo（简单 TV show 模板，M4 可选细化）。

### 4.7 `tools/` — 工具契约

每个工具：`defineTool({ name, description, parameters, output: { schema, render }, timeoutMs, isConcurrencySafe, execute, presentCall?, presentResult? })`。渲染意图统一用 `generic`（结构化 JSON 转文本），不做复杂卡片。

| 工具 | parameters | 行为 | output 要点 | timeout / 并发 |
| ---- | ---------- | ---- | ----------- | -------------- |
| `bili_search` | `query` (req), `type` (video\|bangumi\|cheese\|user\|live_user, 默认 video), `page` (默认 1) | 关键词搜索 | `{ type, page, total, results[] }`，每项含 bvid/epId/ssId/uid、标题、UP、封面、时长、播放/弹幕数 | 20s / 并发安全 |
| `bili_video_info` | `target` (req: bvid \| av 号 \| URL \| ep_id \| ss_id \| uid), `page?`（uid 分页） | URL/ID 解析（原版 search 移植） | `{ kind, title, up, desc, stats, cid 列表 / episodes 列表, audioFormats[], subtitleCount, coverUrl }` | 20s / 并发安全 |
| `bili_download` | `target` (req), `artifact` (audio\|cover\|subtitle\|danmaku\|json\|nfo；省略 = 按配置开启的默认集合), `audioQuality?`, `format?` (danmaku: xml\|json, 默认 xml), `page?` | **下载到本地 `downloadDir`**；入队即返回 | `{ tasks: [{ taskId, artifact, title, targetPath }] }`（`targetPath` 入队时已确定） | 15s（只入队）/ 非并发安全 |
| `bili_download_status` | `taskId?`（缺省列全部） | 轮询进度 | `[{ taskId, artifact, title, state, bytesTotal, bytesDone, percent, targetPath, error? }]` | 5s / 并发安全 |
| `bili_download_control` | `taskId` (req), `action` (cancel\|delete) | 控制下载（pause/resume 可选 M3 末） | `{ taskId, action, ok }` | 5s / 并发安全 |

- **长任务模式**：`bili_download` 只入队（execute 毫秒级返回，`timeoutMs: 5000`），下载在宿主进程后台跑；agent 用 `bili_download_status` 轮询。不注册 `ctx.jobs`——任务注册表自持，语义更贴近原版。
- **理解链路 = 下载 + 自读文件**：字幕/弹幕不设独立取内容工具，统一走 `bili_download(artifact=subtitle|danmaku)` 落盘，agent 再用自身 fs 工具读 `targetPath` 理解内容；音频落盘后可跑本地 ASR（whisper 等，agent 自有 bash 工具执行）。工具面因此只有 5 个，职责不重叠。
- **模型面文本**：description 用模型视角写（"Search bilibili videos / Resolve a bilibili URL or ID / Download audio, cover, subtitle, danmaku, or metadata"），render 输出纯文本结构化摘要；不出现"taskId 是内部实现"之外的实现词。

## 5. 关键技术取舍

1. **弹幕免 protobuf**：原版用 `/x/v2/dm/web/seg.so`（prost 生成的 `bilibili.community.service.dm.v1`，1700 行生成代码）。TS 侧改用 XML 接口 `/x/v1/dm/list.so?oid={cid}`（gzip→XML），无 protobuf 依赖；XML→ASS 转换（原版 `danmaku_xml_to_ass/`，纯逻辑）若需要可后续移植。**弹幕只作为下载产物产出 xml/json 文件**，不做 ASS。
2. **无分片并发**：音频是单个流，`Range` 单请求 + 流式写盘即可。省掉原版 download_chunk_task / 信号量 / 续传状态机一大块。
3. **ffmpeg 仅配置位**：当前无调用点；`ffmpegPath` 预留（未来音频转码 / ASS 合成时用系统 ffmpeg，与用户"强制系统"一致）。
4. **关键词搜索是新增能力**：原版搜索 = URL/ID 解析（`commands.rs::search`）。B 站搜索 API（`wbi/search/type`）是 agent 理解入口，属本设计的核心增量。
5. **匿名降级**：无 SESSDATA 也能搜、看信息、下载字幕/弹幕（低画质音频 + 更高风控概率）；登录只影响音频质量与用户内容（M4）。**实测**（2026-08-20）：匿名 `/x/web-interface/nav` 返回 -101 拿不到 WBI keys，客户端自动降级为不带签名请求（匿名搜索/信息可用）；若匿名 playurl 因此受限，M4 可改为从 B 站首页 HTML 的 `window.__INITIAL_STATE__` 抓 keys。

## 6. 错误处理与边界

- `BiliError`：`code`（-101 未登录 / -352 风控 / -400 请求错误 / -404 不存在）+ 中文 message 原样透出。`src/bilibili/errors.ts` 的 `friendlyBiliError` 把已知 code 映射成模型友好措辞（-352 → "触发风控，稍后重试或放慢频率"；-101 → "配置 sessdata 后重试"），工具 execute 抛错与下载任务 error 字段都走它。
- HTTP 层：网络错误 / 5xx 重试 2 次；4xx 不重试直接报错。
- 文件名：`filename_filter` 后空串 → 报错拒绝写入；目标目录不存在则创建（`mkdir recursive`）。
- 弹幕/字幕是下载产物：工具只返回路径与进度（KB 级），内容读取交给 agent 的 fs 工具自行分段读，避免撑爆工具结果。
- 风控友好：`requestIntervalMs` 默认 200ms、低并发，避免连发触发 -352。

## 7. 安全与隐私

- `SESSDATA` 只存于 dsh-config 配置（cordis.yml / 宿主 settings）；**任何工具输出、render、日志都不含 cookie**。
- 下载目录由用户配置，工具不写配置目录之外的位置。
- 工具结果只返回结构化数据（标题、进度、路径），不返回流 URL 之外的可执行内容。
- 遵守 B 站服务条款与风控：限速、低频、不绕过任何鉴权。

## 8. 测试策略

- **纯逻辑单测**（vitest，mock 掉 http）：`wbi.ts` 签名（与 Rust 对拍固定向量）、`naming.ts` 模板渲染、`filename_filter`、URL 解析（bvid/av/URL/ep/ss/uid 分派）、字幕 json→srt、弹幕 XML 解析。
- **工具层**：`defineTool` schema 校验（schemastery 派生参数校验）、render 输出为纯文本且不含 cookie；注入 mock `http` 验证 execute 行为；`bili_download` 入队即返回 `taskId` + `targetPath`（不阻塞）。
- **真实 API 冒烟**：`scripts/bilibili-smoke.mjs`（`pnpm smoke:bilibili`，env gate `DSH_BILIBILI_E2E=1`，可选 `DSH_BILIBILI_TARGET` / `DSH_BILIBILI_SESSDATA`）：搜索 → 解析 → 下载弹幕/json/nfo 到临时目录并校验落盘（封面尽力而为——CDN 可能被网络环境拦截）。默认跳过，不进 CI 常跑路径。
- **不迁移**：原版 Vue 无对应测试体系；下载器不做端到端 UI 测试（无 UI）。

## 9. 实施里程碑

| 阶段 | 内容 | 验收 | 状态 |
| ---- | ---- | ---- | ---- |
| **M1 基础设施** | types / http / wbi / api（view + search + player + playurl）+ 单测 | `pnpm check` 过；wbi/命名/URL 解析单测绿 | ✅ |
| **M2 信息工具** | `bili_search` / `bili_video_info` 注册上线 | agent 能搜索、按 URL/ID 解析出完整信息（含音频格式与字幕可用性） | ✅ |
| **M3 下载器** | download 单流引擎 + `bili_download` / `bili_download_status` / `bili_download_control` + 任务历史持久化 | agent 能把音频/封面/字幕/弹幕/json **下载到本地**、轮询进度、拿到 `targetPath`，再自读文件完成理解（字幕/弹幕直读、音频跑本地 ASR） | ✅ |
| **M4 打磨** | 错误码映射（`errors.ts`）、弹幕 json 格式（`format=json`）、nfo 产物（`artifact=nfo`）、`downloadArtifacts` 配置生效、真实 API 冒烟脚本（`pnpm smoke:bilibili`）。二维码登录**不做**（按用户决定，登录态只走 sessdata 配置） | 全链路稳定，`pnpm test` 绿，冒烟通过 | ✅ |

每阶段独立可交付；M2/M3 已于 2026-08-20 一并交付（M3 需要下载引擎支撑 `bili_download`，故合并实施），M4 同日完成。

## 10. 文件树（目标态）

```
src/bilibili/
├── index.ts            # 插件入口 + 工具注册
├── settings.ts         # Config schema
├── http.ts             # fetch 封装
├── wbi.ts              # WBI 签名
├── types.ts            # 响应类型
├── api/
│   ├── index.ts        # 汇总导出
│   ├── nav.ts
│   ├── view.ts
│   ├── search.ts
│   ├── player.ts
│   ├── playurl.ts
│   └── user.ts         # M4
├── download/
│   ├── manager.ts        # 任务注册表 + 并发调度 + 历史持久化
│   ├── task.ts           # 单流下载任务（进度/取消/终态）
│   ├── naming.ts         # 文件名过滤 + 命名模板
│   ├── formats.ts        # 字幕→srt、封面 URL 清理、弹幕 XML→json、扩展名
│   ├── nfo.ts            # emby/kodi 风格 NFO 生成
│   └── planner.ts        # 目标→下载单元→任务构建
├── errors.ts             # B 站错误码 → 模型友好文案
├── tools/
│   ├── bili_search.ts
│   ├── bili_video_info.ts
│   ├── bili_download.ts
│   ├── bili_download_status.ts
│   └── bili_download_control.ts
└── tests/                # vitest（与 src 同目录外，见 dsh-config 既有 tests/ 惯例）
```
