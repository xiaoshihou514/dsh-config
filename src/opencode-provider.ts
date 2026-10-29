/**
 * OpenCode Free：在 dsh 原生模型选择器里选中任意 `*-free` 模型，即由本插件
 * 自动拉起 `opencode serve`（v2 API），并把整轮对话交给 opencode 的 agent
 * 后端执行。
 *
 * 形态：
 *  - adapter 是「黑盒 agent 模型」：只把用户文本交给 opencode 会话，opencode
 *    在自己的进程里跑工具（read/edit/bash…）并请求权限，最终把文本流回来。
 *  - dsh 的 agent loop 仍负责会话日志、上下文管理与 UI；dsh 的 tools 不会
 *    重复执行，工具进度只存在于 opencode 侧。
 *  - 只在首次创建 opencode 会话时把 dsh 既有历史拼进提示；之后复用会话，
 *    只发送新增用户消息。
 *  - opencode 的权限请求默认自动允许一次（无人值守）；中断时调用 v2 的
 *    `/api/session/:id/interrupt`。
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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  backendAuthHeader,
  backendBaseUrl,
  ensureBackend,
} from "./opencode-backend.ts";
import { readSessionMap, writeSessionMap } from "./opencode-session-map.ts";

export const name = "dsh-config-opencode";
export const inject = ["llm", "sessions"];

export const PROVIDER = "opencode-free";

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

/** dsh 会话 → opencode 会话，跨 dsh 重启持久化（测试可用环境变量改写路径）。 */
const SESSION_MAP_FILE =
  process.env.DSH_OPENCODE_SESSION_MAP ??
  join(homedir(), ".cache", "dsh-opencode", "sessions.json");

const sessionMap = readSessionMap(SESSION_MAP_FILE);

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
    return { id: existing, created: false };
  }
  if (existing !== undefined) {
    // opencode 侧会话已被删除：忘掉这条映射，下面重建。
    sessionMap.delete(key);
    writeSessionMap(SESSION_MAP_FILE, sessionMap);
  }
  const response = await postJson("/api/session", {
    title: "dsh",
    location: { directory: cwd },
  });
  if (!response.ok) throw new Error(`opencode: create session failed (HTTP ${response.status})`);
  const payload = (await response.json()) as { data?: { id?: string } };
  const id = payload.data?.id;
  if (id === undefined) throw new Error("opencode: create session returned no id");
  sessionMap.set(key, id);
  writeSessionMap(SESSION_MAP_FILE, sessionMap);
  return { id, created: true };
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
  constructor(private readonly ctx?: Context) {
    super();
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

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const key = options.sessionId === undefined ? "default" : String(options.sessionId);
    const text = latestUserText(options.messages);
    if (text === "") {
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }

    await bootstrapBackend();
    const { providerID, modelID } = parseModel(options.model);
    const session = await ensureSession(key, this.sessionCwd(options.sessionId));

    // 复用会话时也要切回用户当前选择的模型。
    const switched = await postJson(`/api/session/${session.id}/model`, {
      model: { providerID, id: modelID },
    });
    if (!switched.ok) {
      throw new Error(`opencode: switch model failed (HTTP ${switched.status})`);
    }

    // 只有新建会话才灌历史；复用会话时 opencode 自己已经记住了上一轮。
    const history = session.created ? seedHistory(options.messages) : "";
    const promptText =
      history === "" ? text : `${history}\n\n[当前用户消息]\n${text}`;

    const signal = options.signal ?? new AbortController().signal;
    const events = openEvents(signal);
    const abortUpstream = (): void => {
      void interruptSession(session.id);
    };
    signal.addEventListener("abort", abortUpstream, { once: true });

    try {
      // 先建立 SSE 连接（消费 server.connected），避免 prompt 触发的早期事件丢失。
      await events.next();
      const prompt = await postJson(`/api/session/${session.id}/prompt`, {
        text: promptText,
      });
      if (!prompt.ok) {
        const detail = await prompt.text().catch(() => "");
        throw new Error(
          `opencode: prompt failed (HTTP ${prompt.status})` +
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

      for await (const event of events) {
        const data = event.data ?? {};
        if (data["sessionID"] !== session.id) continue;
        switch (event.type) {
          case "session.text.delta":
          case "session.reasoning.delta": {
            const delta = data["delta"];
            if (typeof delta !== "string" || delta === "") break;
            const kind = event.type === "session.text.delta" ? "text" : "reasoning";
            const partKey = keyOf(data, kind);
            seenDelta.add(partKey);
            const index = indexOf(partKey);
            yield kind === "text"
              ? { type: "text-delta", index, text: delta }
              : { type: "reasoning-delta", index, text: delta };
            break;
          }
          case "session.text.ended":
          case "session.reasoning.ended": {
            // 非增量 provider 只在完整 part 里给文本。
            const kind = event.type === "session.text.ended" ? "text" : "reasoning";
            const partKey = keyOf(data, kind);
            if (seenDelta.has(partKey) || emittedEnd.has(partKey)) break;
            const full = data["text"];
            if (typeof full !== "string" || full === "") break;
            emittedEnd.add(partKey);
            const index = indexOf(partKey);
            yield kind === "text"
              ? { type: "text-delta", index, text: full }
              : { type: "reasoning-delta", index, text: full };
            break;
          }
          case "session.step.ended": {
            const mapped = mapUsage(data["tokens"] as Record<string, unknown> | undefined);
            if (mapped !== undefined) usage = mapped;
            if (data["finish"] === "length") finishKind = "max-tokens";
            else finishKind = "stop";
            break;
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
                failure: { message: "opencode execution interrupted", code: "ABORTED" },
              },
            };
            return;
          }
          case "session.execution.failed": {
            const error = data["error"] ?? data["reason"] ?? "opencode execution failed";
            yield {
              type: "finish",
              reason: {
                kind: "error",
                failure: {
                  message:
                    typeof error === "string"
                      ? error
                      : JSON.stringify(error).slice(0, 500),
                  code: "PROVIDER",
                },
              },
            };
            return;
          }
          case "permission.asked": {
            const id = data["id"];
            if (typeof id === "string") void replyPermission(session.id, id);
            break;
          }
          default:
            break;
        }
      }

      // SSE 意外结束：把已收到的内容按正常结束处理，避免 UI 卡在流式态。
      if (usage !== undefined) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: finishKind } };
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new LlmError("opencode request aborted by caller", "ABORTED", { cause: error });
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abortUpstream);
      await events.return(undefined).catch(() => undefined);
    }
  }
}

export function createOpencodeAdapter(ctx?: Context): OpencodeServeAdapter {
  return new OpencodeServeAdapter(ctx);
}

/** 注册「OpenCode Free」provider（路由 opencode-free），并后台拉起 serve。 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], createOpencodeAdapter(ctx));
  void bootstrapBackend();
}
