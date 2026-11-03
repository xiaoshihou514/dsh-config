/**
 * OpenCode Free：在 dsh 原生模型选择器里选中任意 `*-free` 模型，即由本插件
 * 自动拉起 `opencode serve`（v2 API），并把整轮对话交给 opencode 的 agent
 * 后端执行。
 *
 * 形态：
 *  - adapter 是「黑盒 agent 模型」：只把用户文本交给 opencode 会话，opencode
 *    在自己的进程里跑工具（read/edit/bash…）并请求权限，最终把文本流回来。
 *  - 工具调用写回 dsh 会话供 UI 展示；待办与目标同步到对应面板。dsh 不重复
 *    执行这些工具，目标也不在 dsh 侧自动续跑。
 *  - 只在首次创建 opencode 会话时把 dsh 既有历史拼进提示；之后复用会话，
 *    只发送新增用户消息。
 *  - opencode 的权限请求默认自动允许一次（无人值守）；中断时调用 v2 的
 *    `/api/session/:id/interrupt`。
 *  - 免费模型 429 并切走出口后，不再沿用原会话：先把已有内容总结，再开
 *    新的 opencode 会话继续，避免上游从消息序号把换 IP 前后认成同一次对话。
 *
 * v2 的 serve 需要 Basic 认证（用户名 `opencode`），密码与端口由
 * `./opencode-backend.ts` 统一管理，dsh 重启后可复用同一实例。
 */

import type { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { ResolvedRetryPolicy } from "@deepseek-ai/dsh-llm";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEST_URL,
  createClashRotator,
  resolveClashOptions,
  type ClashRotator,
} from "./clash.ts";
import {
  backendAuthHeader,
  backendBaseUrl,
  ensureBackend,
} from "./opencode-backend.ts";
import {
  createOpencodeActivity,
  openOpencodeSink,
  type OpencodeActivity,
} from "./opencode-activity.ts";
import {
  formatOpencodeTranscript,
  handoffPrompt,
  localDigest,
  scrubIds,
} from "./opencode-handoff.ts";
import { readSessionMap, writeSessionMap } from "./opencode-session-map.ts";

export const name = "dsh-config-opencode";
// agents / goals 必须声明 inject，否则 Cordis 隔离上下文读取时会抛
// cannot get property "agents" without inject，工具卡和目标都写不回去。
export const inject = ["llm", "sessions", "agents", "goals"];

export const PROVIDER = "opencode-free";

/**
 * 免费模型限流时自动切换 Clash 出口节点。
 *
 * 默认启用：探测不到 Clash（或没配代理组）时只是跳过切换，不影响正常请求。
 * 也可以用 `DSH_CLASH_DISABLE=1`、`DSH_CLASH_API`、`DSH_CLASH_GROUP` 等
 * 环境变量临时覆盖，详见 `./clash.ts`。
 */
export const Config = z.object({
  /** 限流时自动切换出口节点。 */
  clashEnabled: z.boolean().default(true),
  /** external-controller 地址（unix socket 路径或 http://127.0.0.1:9090）；留空自动探测。 */
  clashApi: z.string().default(""),
  /** external-controller 的 secret。 */
  clashSecret: z.string().default(""),
  /** 手动指定代理组；留空按 opencode.ai 的实际连接链自动识别。 */
  clashGroup: z.string().default(""),
  /** 节点延迟测试 URL。 */
  clashTestUrl: z.string().default(DEFAULT_TEST_URL),
  /** 测速超时（ms）。 */
  clashTimeoutMs: z.number().default(3_000),
  /** 两次自动切换的最小间隔（ms）。 */
  clashCooldownMs: z.number().default(3_000),
  /** 最近切换过的节点数量，避免来回弹。 */
  clashAvoidRecent: z.number().default(3),
  /** 限流后重发同一轮请求的最大次数。 */
  limitRetries: z.number().default(3),
});

export interface OpencodeConfig {
  clashEnabled?: boolean;
  clashApi?: string;
  clashSecret?: string;
  clashGroup?: string;
  clashTestUrl?: string;
  clashTimeoutMs?: number;
  clashCooldownMs?: number;
  clashAvoidRecent?: number;
  limitRetries?: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;
const FREE_SUFFIX = "-free";

interface OpencodeModel {
  id: string;
  providerID: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * 内置兜底清单：后端不可达时目录不为空（可直接选中并触发自动拉起）。
 * 与 `GET /api/model?types=chat` 中的 `-free` 模型保持一致。
 */
const FALLBACK_MODELS: OpencodeModel[] = [
  {
    id: "deepseek-v4.1-flash-free",
    providerID: "opencode",
    name: "DeepSeek V4.1 Flash Free",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "glm-5.3-flash-free",
    providerID: "opencode",
    name: "GLM-5.3-Flash Free",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "mimo-v2.6-flash-free",
    providerID: "opencode",
    name: "MiMo-V2.6-Flash Free",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "flint-40b-free",
    providerID: "opencode",
    name: "Flint 40B Free",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
  },
  {
    id: "nemotron-3.5-super-vl-free",
    providerID: "opencode",
    name: "Nemotron 3.5 Super VL Free",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  },
  {
    id: "nemotron-3.5-lightning-free",
    providerID: "opencode",
    name: "Nemotron 3.5 Lightning Free",
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
  },
  {
    id: "beam-free",
    providerID: "opencode",
    name: "Beam Free",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  },
];

/** 与 codex/copilot 同款的限流/网络错误指数退避。 */
const RETRY_POLICY = {
  mode: "normal",
  maxRetries: 3,
  retryableCodes: [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
  ],
  backoff: { initialDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
} satisfies import("@deepseek-ai/dsh-llm").RetryPolicyConfig;

let cached: OpencodeModel[] = FALLBACK_MODELS;

/**
 * opencode 的免费额度/限流失败：`provider.free-limit`（配额类，通常不自动
 * 重试）、`provider.rate-limit`（429）以及消息里带 429/rate limit 的兜底。
 */
const LIMIT_PATTERN =
  /(?:^|\D)429(?:\D|$)|rate[\s_-]?limit|too many requests|free usage limit|freeusagelimiterror/i;

/** 从 opencode 的错误对象/字符串里识别限流；命中返回可读的标记。 */
export function limitFailure(value: unknown): string | undefined {
  if (typeof value === "string")
    return LIMIT_PATTERN.test(value) ? value.slice(0, 200) : undefined;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record["type"] === "string" ? record["type"] : "";
  if (type === "provider.free-limit" || type === "provider.rate-limit")
    return type;
  for (const key of ["message", "body", "detail", "error"]) {
    const found = limitFailure(record[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 自动切换节点；`undefined` 表示 Clash 不可用，调用方应放弃追加重试。 */
let rotator: ClashRotator = createClashRotator(resolveClashOptions());
let limitRetries = 3;
/** 同一出口连续碰到这么多次 429，才换下一个节点。 */
const LIMITS_BEFORE_ROTATE = 3;

function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function authHeaders(): Record<string, string> {
  return { authorization: backendAuthHeader() };
}

/** 从 serve 拉取实际提供的 `*-free` 模型；失败保留兜底清单。 */
async function refreshModels(): Promise<void> {
  try {
    const response = await fetch(`${backendBaseUrl()}/api/model?types=chat`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      data?: {
        id?: string;
        modelID?: string;
        providerID?: string;
        name?: string;
        limit?: { context?: number; output?: number };
      }[];
    };
    const found: OpencodeModel[] = [];
    for (const model of body.data ?? []) {
      const id = model.modelID ?? model.id;
      if (id === undefined || !id.endsWith(FREE_SUFFIX)) continue;
      found.push({
        id,
        providerID: model.providerID ?? "opencode",
        name: model.name ?? id,
        contextWindow: model.limit?.context ?? DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: model.limit?.output ?? DEFAULT_MAX_TOKENS,
      });
    }
    if (found.length > 0) cached = found;
  } catch {
    // 后端不可达：保留兜底清单，用户仍可选中并触发拉起。
  }
}

let bootstrap: Promise<void> | undefined;

/** 后台确保 serve 可用并刷新模型清单（进程级单例）。 */
function bootstrapBackend(): Promise<void> {
  bootstrap ??= (async () => {
    await ensureBackend();
    await refreshModels();
  })().catch((error: unknown) => {
    // opencode 未安装等：保留兜底清单，请求阶段再报错。
    console.error("[dsh-config] opencode bootstrap failed:", error);
  });
  return bootstrap;
}

function textOf(message: GenerateOptions["messages"][number]): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/** 本轮真正要发给 opencode 的最新用户文本（跳过工具结果等）。 */
function latestUserText(messages: GenerateOptions["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    const text = textOf(message);
    if (text.trim() !== "") return text;
  }
  return "";
}

/** 首次建会话时灌入的历史（不含最后一条用户消息）。 */
function seedHistory(messages: GenerateOptions["messages"]): string {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const lines: string[] = [];
  for (const message of messages.slice(0, lastUser === -1 ? messages.length : lastUser)) {
    // dsh 的 system prompt 不转交：opencode 有自己的 agent/system prompt。
    if (message.role === "system") continue;
    const text = textOf(message);
    if (text.trim() === "") continue;
    lines.push(`${message.role === "assistant" ? "助手" : "用户"}：${text}`);
  }
  if (lines.length === 0) return "";
  return `以下是此前的对话，请在此基础上继续：\n\n${lines.join("\n\n")}`;
}

/**
 * 辅助请求（会话标题生成、上下文压缩）不是一轮 agent 对话：它们既不该
 * 复用主会话（会把标题指令当成用户消息写进 opencode 历史），也不该让
 * opencode 的 agent loop 执行。这里把它们拼成单次文本生成提示，交给
 * serve 的无会话生成端点。
 */
function auxiliaryPrompt(options: GenerateOptions): string {
  const parts: string[] = [];
  if (options.system !== undefined && options.system.trim() !== "") {
    parts.push(options.system);
  }
  if (options.purpose === "session-title") {
    const text = latestUserText(options.messages);
    if (text !== "") parts.push(text);
    return parts.join("\n\n");
  }
  for (const message of options.messages) {
    if (message.role === "system") continue;
    const text = textOf(message);
    if (text.trim() === "") continue;
    parts.push(`${message.role === "assistant" ? "助手" : "用户"}：${text}`);
  }
  return parts.join("\n\n");
}

/** dsh 会话 → opencode 会话，跨 dsh 重启持久化（测试可用环境变量改写路径）。 */
const SESSION_MAP_FILE =
  process.env.DSH_OPENCODE_SESSION_MAP ??
  join(homedir(), ".cache", "dsh-opencode", "sessions.json");

const sessionMap = readSessionMap(SESSION_MAP_FILE);

/**
 * 限流换出口后、下一次发言才用得上的交接摘要。
 * 本轮已经输出过内容时不能当场重说，摘要留到下一条用户消息。
 */
const pendingHandoff = new Map<string, string>();

type LimitShift =
  | { action: "skipped" }
  | { action: "parked" }
  | { action: "retry"; sessionId: string; prompt: string; retries: number };

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${backendBaseUrl()}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type SessionState = "alive" | "missing" | "unknown";

/**
 * 探测 opencode 会话是否仍在。只有明确的 404 才算「已删除」；超时、5xx
 * 等一律视为「未知」并继续复用——否则 serve 刚启动时的慢响应就会被误判
 * 成会话不存在，白白重建会话。
 */
async function sessionState(id: string): Promise<SessionState> {
  try {
    const response = await fetch(`${backendBaseUrl()}/api/session/${id}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return "alive";
    return response.status === 404 ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

/** 同一 dsh 会话的并发请求共享一次建立/复用，避免各建一个 opencode 会话。 */
const ensuring = new Map<string, Promise<{ id: string; created: boolean }>>();

/** 复用 dsh 会话映射的 opencode 会话；确认已删除时才新建。 */
async function ensureSession(
  key: string,
  cwd: string,
): Promise<{ id: string; created: boolean }> {
  const running = ensuring.get(key);
  if (running !== undefined) return running;
  const task = openSession(key, cwd).finally(() => ensuring.delete(key));
  ensuring.set(key, task);
  return task;
}

async function openSession(
  key: string,
  cwd: string,
): Promise<{ id: string; created: boolean }> {
  const existing = sessionMap.get(key);
  if (existing !== undefined && (await sessionState(existing)) !== "missing") {
    // 已有会话如果建在别的目录，工作区视图不会把它列在当前文件夹下。
    const location = await sessionLocation(cwd);
    await placeSession(existing, location.directory);
    return { id: existing, created: false };
  }
  if (existing !== undefined) {
    // opencode 侧会话已被删除：忘掉这条映射，下面重建。
    sessionMap.delete(key);
    writeSessionMap(SESSION_MAP_FILE, sessionMap);
  }
  return { id: await createSession(key, cwd), created: true };
}

/** 丢掉当前映射并新建 opencode 会话，消息序号从 1 重新开始。 */
async function replaceSession(key: string, cwd: string): Promise<string> {
  sessionMap.delete(key);
  writeSessionMap(SESSION_MAP_FILE, sessionMap);
  return createSession(key, cwd);
}

async function createSession(key: string, cwd: string): Promise<string> {
  // 工作区视图按 location.get 返回的规范目录和 subpath 列会话。
  // 直接传原始 cwd（符号链接、尾斜杠）会对不上文件夹，会话就进不了该目录。
  const location = await sessionLocation(cwd);
  const response = await postJson("/api/session", {
    title: "dsh",
    location,
  });
  if (!response.ok) throw new Error(`opencode: create session failed (HTTP ${response.status})`);
  const payload = (await response.json()) as { data?: { id?: string } };
  const id = payload.data?.id;
  if (id === undefined) throw new Error("opencode: create session returned no id");
  sessionMap.set(key, id);
  writeSessionMap(SESSION_MAP_FILE, sessionMap);
  return id;
}

/** 从 `GET /api/location` 的响应里取出工作区视图使用的目录。 */
export function directoryFromLocation(body: unknown, fallback: string): string {
  if (body === null || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const data =
    record["data"] !== null && typeof record["data"] === "object"
      ? (record["data"] as Record<string, unknown>)
      : record;
  const location =
    record["location"] !== null && typeof record["location"] === "object"
      ? (record["location"] as Record<string, unknown>)
      : undefined;
  const directory =
    typeof data["directory"] === "string"
      ? data["directory"]
      : location !== undefined && typeof location["directory"] === "string"
        ? location["directory"]
        : undefined;
  return directory !== undefined && directory.trim() !== "" ? directory : fallback;
}

async function sessionDirectory(id: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${backendBaseUrl()}/api/session/${id}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: { location?: { directory?: string } };
      location?: { directory?: string };
    };
    const directory = body.data?.location?.directory ?? body.location?.directory;
    return typeof directory === "string" && directory !== "" ? directory : undefined;
  } catch {
    return undefined;
  }
}

/** 把已有会话挪到工作区视图正在看的那个目录。 */
async function placeSession(id: string, directory: string): Promise<void> {
  const current = await sessionDirectory(id);
  if (current === undefined || current === directory) return;
  await postJson(`/api/session/${id}/move`, { directory }).catch(() => undefined);
}

async function sessionLocation(cwd: string): Promise<{ directory: string }> {
  try {
    const url = new URL(`${backendBaseUrl()}/api/location`);
    // deepObject：与 OpenCode 客户端的 location.get({ directory }) 一致。
    url.search = `location[directory]=${encodeURIComponent(cwd)}`;
    const response = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { directory: cwd };
    return { directory: directoryFromLocation(await response.json(), cwd) };
  } catch {
    return { directory: cwd };
  }
}

function conversationTranscript(messages: GenerateOptions["messages"]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = textOf(message);
    if (text.trim() === "") continue;
    const label =
      message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : message.role;
    lines.push(`${label}：${text}`);
  }
  return lines.join("\n\n");
}

async function loadTranscript(sessionId: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(
      `${backendBaseUrl()}/api/session/${sessionId}/message?limit=80&order=asc`,
      { headers: authHeaders(), signal },
    );
    if (!response.ok) return "";
    return formatOpencodeTranscript(await response.json());
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    return "";
  }
}

/** 换出口之后做一次无会话总结；失败则退回截短的原文。 */
async function handoverBrief(
  sessionId: string,
  model: { providerID: string; id: string },
  fallback: string,
  signal: AbortSignal,
): Promise<string> {
  const remote = scrubIds(await loadTranscript(sessionId, signal));
  const source = remote.trim() !== "" ? remote : scrubIds(fallback);
  if (source.trim() === "") return "";
  const summary = await summarize(source, model, signal);
  return (summary ?? localDigest(source)).trim();
}

function consumePendingHandoff(key: string, userText: string, normal: string): string {
  const parked = pendingHandoff.get(key);
  if (parked === undefined) return normal;
  pendingHandoff.delete(key);
  return handoffPrompt(parked, userText);
}

function limitFinish(error: unknown): StreamChunk {
  const message =
    typeof error === "string"
      ? error
      : error === undefined
        ? "opencode rate limit"
        : JSON.stringify(error).slice(0, 500);
  return {
    type: "finish",
    reason: {
      kind: "error",
      failure: { message, code: "RATE_LIMIT" },
    },
  };
}

async function summarize(
  transcript: string,
  model: { providerID: string; id: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  const clipped =
    transcript.length <= 24_000
      ? transcript
      : `${transcript.slice(0, 16_000)}\n\n…\n\n${transcript.slice(-7_000)}`;
  const prompt = [
    "把下面的编程会话压成交接摘要，给一个全新的会话继续干活。",
    "保留用户目标、已改文件、关键结论和未完成事项。",
    "不要写会话编号、消息序号或内部 id。不要粘贴工具的原始长输出。",
    "",
    clipped,
  ].join("\n");
  try {
    const response = await fetch(`${backendBaseUrl()}/api/experimental/generate/text`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ prompt, model }),
      signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as
      | { data?: { text?: string } }
      | undefined;
    const text = body?.data?.text?.trim() ?? "";
    return text === "" ? undefined : scrubIds(text);
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

interface ServerEvent {
  type?: string;
  data?: Record<string, unknown>;
}

/** 订阅 opencode v2 全局 SSE，逐帧产出 JSON 事件（`data:` 行）。 */
async function* openEvents(signal: AbortSignal): AsyncGenerator<ServerEvent> {
  const response = await fetch(`${backendBaseUrl()}/api/event`, {
    headers: { ...authHeaders(), accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`opencode: event stream failed (HTTP ${response.status})`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trimStart();
          if (payload === "") continue;
          try {
            yield JSON.parse(payload) as ServerEvent;
          } catch {
            // 忽略坏帧。
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function mapUsage(tokens: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (tokens === undefined) return undefined;
  const cache = tokens["cache"] as Record<string, unknown> | undefined;
  const usage: TokenUsage = {
    inputTokens: typeof tokens["input"] === "number" ? tokens["input"] : 0,
    outputTokens: typeof tokens["output"] === "number" ? tokens["output"] : 0,
  };
  if (typeof tokens["reasoning"] === "number") usage.reasoningTokens = tokens["reasoning"];
  if (typeof cache?.["read"] === "number") usage.cacheReadTokens = cache["read"];
  if (typeof cache?.["write"] === "number") usage.cacheWriteTokens = cache["write"];
  return usage;
}

async function replyPermission(sessionID: string, requestID: string): Promise<void> {
  await postJson(`/api/session/${sessionID}/permission/${requestID}/reply`, {
    decision: "once",
  }).catch(() => undefined);
}

async function interruptSession(id: string): Promise<void> {
  await postJson(`/api/session/${id}/interrupt`).catch(() => undefined);
}

class OpencodeServeAdapter extends LlmAdapter {
  constructor(
    private readonly ctx?: Context,
    private readonly clash: ClashRotator = rotator,
  ) {
    super();
  }

  /**
   * 切换到还没在本轮试过的出口。`tried` 会记下换之前和换之后的节点，
   * 组里每个节点最多用一次。
   */
  private async rotate(reason: string, tried?: Set<string>): Promise<boolean> {
    try {
      const result = await this.clash.rotate(
        reason,
        tried === undefined ? undefined : { skip: [...tried] },
      );
      if (result === undefined || tried?.has(result.to) === true) return false;
      tried?.add(result.from);
      tried?.add(result.to);
      return true;
    } catch (error: unknown) {
      console.error("[dsh-config] clash rotation failed:", error);
      return false;
    }
  }

  /** dsh 会话的 cwd（会话日志按项目分目录）；未入 store 时回退进程目录。 */
  private sessionCwd(sessionId: GenerateOptions["sessionId"]): string {
    if (sessionId !== undefined) {
      try {
        const cwd = this.ctx?.sessions.get(sessionId)?.header.cwd;
        if (cwd !== undefined && cwd !== "") return cwd;
      } catch {
        // 会话尚未进入 store 等：回退进程目录。
      }
    }
    return process.cwd();
  }

  /**
   * 同一出口的 429 要攒满 3 次才换节点。还没展示给用户时，前两次在原会话上立刻重发。
   */
  private noteLimit(
    strikes: number,
    emitted: boolean,
  ): { strikes: number; action: "retry-same" | "rotate" | "surface" } {
    const next = strikes + 1;
    if (next < LIMITS_BEFORE_ROTATE) {
      return { strikes: next, action: emitted ? "surface" : "retry-same" };
    }
    return { strikes: 0, action: "rotate" };
  }

  /**
   * 限流且出口已经换成新 IP 时，旧会话不能再续：序号还接着会暴露换线。
   * 先总结旧内容，再换一个新会话。本轮还没展示给用户时立刻用摘要重发；
   * 已经展示过就先存下摘要，等下一条用户消息再交给新会话。
   */
  private async shiftAfterLimit(input: {
    reason: string;
    key: string;
    cwd: string;
    sessionId: string;
    userText: string;
    fallback: string;
    model: { providerID: string; id: string };
    signal: AbortSignal;
    emitted: boolean;
    retries: number;
    tried: Set<string>;
  }): Promise<LimitShift> {
    if (!(await this.rotate(input.reason, input.tried))) return { action: "skipped" };
    const brief = await handoverBrief(
      input.sessionId,
      input.model,
      input.fallback,
      input.signal,
    );
    await interruptSession(input.sessionId);
    const sessionId = await replaceSession(input.key, input.cwd);
    // 连续 3 次 429 后才换出口；换过的节点本轮不再用。
    if (!input.emitted) {
      return {
        action: "retry",
        sessionId,
        prompt: handoffPrompt(brief, input.userText),
        retries: input.retries + 1,
      };
    }
    if (brief !== "") pendingHandoff.set(input.key, brief);
    return { action: "parked" };
  }

  override providerInfo(provider: string) {
    return { id: provider, name: "OpenCode Free" };
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(RETRY_POLICY, `${provider} retryPolicy`);
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return cached.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
    }));
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const parsed = parseModel(model);
    const found = cached.find(
      (candidate) =>
        candidate.id === parsed.modelID && candidate.providerID === parsed.providerID,
    );
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      context: { contextWindow: found?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: found?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: ["text"],
      reasoning: {
        efforts: [
          { id: "low" as never, name: "Low" },
          { id: "medium" as never, name: "Medium" },
          { id: "high" as never, name: "High" },
        ],
        defaultEffort: "high" as never,
      },
    };
  }

  /**
   * 辅助请求走 serve 的无会话文本生成端点：不创建/复用 opencode 会话，
   * 因而不会把标题指令写进用户对话，也不会被标题生成的事件污染。
   */
  private async *auxiliaryStream(
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    await bootstrapBackend();
    const prompt = auxiliaryPrompt(options);
    if (prompt === "") {
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const { providerID, modelID } = parseModel(options.model);
    let response: Response | undefined;
    let body: { data?: { text?: string }; message?: string } | undefined;
    for (let attempt = 0; attempt <= limitRetries; attempt += 1) {
      response = await fetch(
        `${backendBaseUrl()}/api/experimental/generate/text`,
        {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ prompt, model: { providerID, id: modelID } }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      body = (await response.json().catch(() => undefined)) as
        { data?: { text?: string }; message?: string } | undefined;
      if (response.ok) break;
      const detail = body?.message ?? `HTTP ${response.status}`;
      // 辅助请求（标题/压缩）每次都是独立的一次生成，可以放心换节点后重发。
      if (
        (response.status === 429 || limitFailure(detail) !== undefined) &&
        attempt < limitRetries &&
        (await this.rotate(`auxiliary ${response.status}`))
      ) {
        continue;
      }
      throw new LlmError(
        `opencode: auxiliary generate failed (${detail})`,
        response.status === 429 || limitFailure(detail) !== undefined
          ? "RATE_LIMIT"
          : "PROVIDER",
      );
    }
    if (response === undefined || !response.ok) {
      throw new LlmError("opencode: auxiliary generate failed", "RATE_LIMIT");
    }
    const text = body?.data?.text ?? "";
    if (text !== "") yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield* this.auxiliaryStream(options);
      return;
    }
    const key = options.sessionId === undefined ? "default" : String(options.sessionId);
    const text = latestUserText(options.messages);
    if (text === "") {
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }

    await bootstrapBackend();
    const model = parseModel(options.model);
    const cwd = this.sessionCwd(options.sessionId);
    const session = await ensureSession(key, cwd);
    const fallback = conversationTranscript(options.messages);

    // 只有新建会话才灌历史；复用会话时 opencode 自己已经记住了上一轮。
    // 限流换过出口时，下一条消息改走摘要，不再接着旧序号。
    const history = session.created ? seedHistory(options.messages) : "";
    const freshPrompt = history === "" ? text : `${history}\n\n[当前用户消息]\n${text}`;
    let sessionId = session.id;
    let activePrompt = consumePendingHandoff(key, text, freshPrompt);

    const signal = options.signal ?? new AbortController().signal;
    /** 已经向 UI 输出过内容后就不再自动重发，避免重复文本。 */
    let emitted = false;
    let retries = 0;
    let limitStrikes = 0;
    const triedNodes = new Set<string>();
    const sink = openOpencodeSink(this.ctx, options.sessionId);
    const shiftInput = () => ({
      key,
      cwd,
      sessionId,
      userText: text,
      fallback,
      model: { providerID: model.providerID, id: model.modelID },
      signal,
      emitted,
      retries,
      tried: triedNodes,
    });

    for (;;) {
      const attemptId = sessionId;
      const events = openEvents(signal);
      const abortUpstream = (): void => {
        void interruptSession(attemptId);
      };
      signal.addEventListener("abort", abortUpstream, { once: true });
      let retry = false;
      let activity: OpencodeActivity | undefined;

      try {
        activity = createOpencodeActivity(sink, attemptId);
        // 先建立 SSE 连接（消费 server.connected），避免 prompt 触发的早期事件丢失。
        await events.next();
        const switched = await postJson(`/api/session/${attemptId}/model`, {
          model: { providerID: model.providerID, id: model.modelID },
        });
        if (!switched.ok) {
          throw new Error(`opencode: switch model failed (HTTP ${switched.status})`);
        }
        const prompted = await postJson(`/api/session/${attemptId}/prompt`, {
          text: activePrompt,
        });
        if (!prompted.ok) {
          const detail = await prompted.text().catch(() => "");
          if (prompted.status === 429) {
            const noted = this.noteLimit(limitStrikes, emitted);
            limitStrikes = noted.strikes;
            if (noted.action === "retry-same") continue;
            if (noted.action === "rotate") {
              const shift = await this.shiftAfterLimit({
                ...shiftInput(),
                reason: `prompt ${prompted.status}`,
              });
              if (shift.action === "retry") {
                sessionId = shift.sessionId;
                activePrompt = shift.prompt;
                retries = shift.retries;
                continue;
              }
            }
          }
          throw new Error(
            `opencode: prompt failed (HTTP ${prompted.status})` +
              (detail === "" ? "" : ` ${detail.slice(0, 300)}`),
          );
        }

        let nextIndex = 0;
        const partIndex = new Map<string, number>();
        const seenDelta = new Set<string>();
        const emittedEnd = new Set<string>();
        let usage: TokenUsage | undefined;
        let finishKind: "stop" | "max-tokens" = "stop";

        const indexOf = (partKey: string): number => {
          let index = partIndex.get(partKey);
          if (index === undefined) {
            index = nextIndex;
            nextIndex += 1;
            partIndex.set(partKey, index);
          }
          return index;
        };

        const keyOf = (
          data: Record<string, unknown>,
          kind: "text" | "reasoning",
        ): string =>
          `${String(data["assistantMessageID"])}:${String(data["ordinal"])}:${kind}`;

        eventLoop: for await (const event of events) {
          const data = event.data ?? {};
          if (data["sessionID"] !== attemptId) continue;
          // 工具卡、待办和目标写进 dsh 会话；不把它们编进模型流，避免 loop 再执行。
          if (activity?.observe(event)) emitted = true;
          switch (event.type) {
            case "session.text.delta":
            case "session.reasoning.delta": {
              const delta = data["delta"];
              if (typeof delta !== "string" || delta === "") break;
              const kind =
                event.type === "session.text.delta" ? "text" : "reasoning";
              const partKey = keyOf(data, kind);
              seenDelta.add(partKey);
              emitted = true;
              const index = indexOf(partKey);
              yield kind === "text"
                ? { type: "text-delta", index, text: delta }
                : { type: "reasoning-delta", index, text: delta };
              break;
            }
            case "session.text.ended":
            case "session.reasoning.ended": {
              // 非增量 provider 只在完整 part 里给文本。
              const kind =
                event.type === "session.text.ended" ? "text" : "reasoning";
              const partKey = keyOf(data, kind);
              if (seenDelta.has(partKey) || emittedEnd.has(partKey)) break;
              const full = data["text"];
              if (typeof full !== "string" || full === "") break;
              emittedEnd.add(partKey);
              emitted = true;
              const index = indexOf(partKey);
              yield kind === "text"
                ? { type: "text-delta", index, text: full }
                : { type: "reasoning-delta", index, text: full };
              break;
            }
            case "session.step.ended": {
              const mapped = mapUsage(
                data["tokens"] as Record<string, unknown> | undefined,
              );
              if (mapped !== undefined) usage = mapped;
              if (data["finish"] === "length") finishKind = "max-tokens";
              else finishKind = "stop";
              break;
            }
            case "session.retry.scheduled": {
              // opencode 准备在同一会话里重试。未满 3 次就打断它的长等待，立刻重发。
              // 满 3 次才换出口；换了出口就不能让它接着原序号打。
              if (limitFailure(data["error"]) === undefined) break;
              const noted = this.noteLimit(limitStrikes, emitted);
              limitStrikes = noted.strikes;
              if (noted.action === "retry-same") {
                await interruptSession(attemptId);
                retry = true;
                break eventLoop;
              }
              if (noted.action === "surface") {
                await interruptSession(attemptId);
                yield limitFinish(data["error"]);
                return;
              }
              const shift = await this.shiftAfterLimit({
                ...shiftInput(),
                reason: "opencode retry",
              });
              if (shift.action === "skipped") break;
              if (shift.action === "retry") {
                sessionId = shift.sessionId;
                activePrompt = shift.prompt;
                retries = shift.retries;
                retry = true;
                break eventLoop;
              }
              yield limitFinish(data["error"]);
              return;
            }
            case "session.execution.succeeded": {
              if (usage !== undefined) yield { type: "usage", usage };
              yield { type: "finish", reason: { kind: finishKind } };
              return;
            }
            case "session.execution.interrupted": {
              yield {
                type: "finish",
                reason: {
                  kind: "aborted",
                  failure: {
                    message: "opencode execution interrupted",
                    code: "ABORTED",
                  },
                },
              };
              return;
            }
            case "session.execution.failed": {
              const error =
                data["error"] ?? data["reason"] ?? "opencode execution failed";
              const limited = limitFailure(error) !== undefined;
              if (limited) {
                const noted = this.noteLimit(limitStrikes, emitted);
                limitStrikes = noted.strikes;
                if (noted.action === "retry-same") {
                  retry = true;
                  break eventLoop;
                }
                if (noted.action === "rotate") {
                  const shift = await this.shiftAfterLimit({
                    ...shiftInput(),
                    reason: "execution limit",
                  });
                  if (shift.action === "retry") {
                    sessionId = shift.sessionId;
                    activePrompt = shift.prompt;
                    retries = shift.retries;
                    retry = true;
                    break eventLoop;
                  }
                }
              }
              yield {
                type: "finish",
                reason: {
                  kind: "error",
                  failure: {
                    message:
                      typeof error === "string"
                        ? error
                        : JSON.stringify(error).slice(0, 500),
                    code: limited ? "RATE_LIMIT" : "PROVIDER",
                  },
                },
              };
              return;
            }
            case "permission.asked": {
              const id = data["id"];
              if (typeof id === "string") void replyPermission(attemptId, id);
              break;
            }
            default:
              break;
          }
        }

        if (retry) continue;

        // SSE 意外结束：把已收到的内容按正常结束处理，避免 UI 卡在流式态。
        if (usage !== undefined) yield { type: "usage", usage };
        yield { type: "finish", reason: { kind: finishKind } };
        return;
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new LlmError("opencode request aborted by caller", "ABORTED", {
            cause: error,
          });
        }
        throw error;
      } finally {
        activity?.close();
        signal.removeEventListener("abort", abortUpstream);
        await events.return(undefined).catch(() => undefined);
      }
    }
  }
}

export function createOpencodeAdapter(
  ctx?: Context,
  clash?: ClashRotator,
): OpencodeServeAdapter {
  return new OpencodeServeAdapter(ctx, clash ?? rotator);
}

/** 注册「OpenCode Free」provider（路由 opencode-free），并后台拉起 serve。 */
export function apply(ctx: Context, config: OpencodeConfig = {}): void {
  const options = resolveClashOptions({
    enabled: config.clashEnabled,
    api: config.clashApi,
    secret: config.clashSecret,
    group: config.clashGroup,
    testUrl: config.clashTestUrl,
    timeoutMs: config.clashTimeoutMs,
    cooldownMs: config.clashCooldownMs,
    avoidRecent: config.clashAvoidRecent,
  });
  rotator = createClashRotator(options);
  limitRetries = Math.max(0, Math.trunc(config.limitRetries ?? 3));
  ctx.llm.registerAdapter([PROVIDER], new OpencodeServeAdapter(ctx, rotator));
  void bootstrapBackend();
}
