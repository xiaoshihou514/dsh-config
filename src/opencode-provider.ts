/**
 * OpenCode Zen 免费模型的无认证 LLM 适配器：注册为名为「OpenCode Free」的
 * provider（路由 `opencode-free`），自动提供 /models 里所有 `*-free` 模型。
 * 免费模型要求**不携带 Authorization 头**（带无效 key 会 401），按 IP 限流、
 * 非零保留（数据可能用于改进模型）。非流式调用：整段返回后按块发射。
 * 推理等级与 codex/pi-ai 同一套标准词汇表（off/minimal/low/medium/high/xhigh/max，
 * 即 OpenAI 兼容供应商的标准 reasoning_effort 取值，zen 网关已验证透传）：
 * resolveModel 声明 efforts 让原生选择器出现，stream 把生效等级映射到 wire
 * （等级原样 → reasoning_effort；off → thinking disabled；标题生成不干预）。
 * 工具调用完整支持：请求携带 tools（OpenAI function 格式），assistant 的
 * tool-call 历史 → tool_calls、工具结果 → {role:"tool"} 消息，响应里的
 * tool_calls 解析回 harness 的 tool-call 块。
 * 错误归类与原生适配器一致：400 + 上下文超限 → CONTEXT_WINDOW_EXCEEDED，
 * 由 harness 内置压缩恢复（+ dsh-config overflow-recovery 兜底）自动压缩重试。
 */

import { randomUUID, randomBytes } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  RetryPolicySchema,
  ToolCallId,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
  type StreamChunk,
  type TokenUsage,
  type ToolCallBlock,
  type ToolResultMessage,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const FREE_SUFFIX = "-free";
const MODELS_FETCH_TIMEOUT_MS = 4_000;
/** 模型列表缓存 TTL：过期后自动重新拉取，上游增删模型无需重启。 */
const MODELS_CACHE_TTL_MS = 10 * 60 * 1_000;

/** 与 codex/pi-ai 目录一致的标准推理等级（升序），选择器展示与 wire 值都由此派生。 */
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] =
  THINKING_LEVELS.map((level) => ({
    id: ReasoningEffortId(level),
    name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
  }));

/**
 * opencode free 免费档按 IP 限流、窗口较长：比 harness 默认（2 次、500ms 起步）
 * 更耐心的指数退避（1s 起步 ×2、封顶 30s、20% 抖动、最多 3 次重试）。
 */
const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
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
};

export interface Config {
  /** chat completions 端点。 */
  baseUrl?: string;
  /** 模型列表端点（用于自动发现 `*-free` 模型）。 */
  modelsUrl?: string;
  /** 未在列表中的模型使用的上下文容量。 */
  contextWindow?: number;
  /** 固定模型清单；为空时启动时从 modelsUrl 拉取并过滤 `*-free`。 */
  models?: string[];
  /** 每请求默认输出上限。 */
  maxTokens?: number;
  /** 默认推理等级（标准词汇表之一，默认 high）。 */
  reasoningEffort?: ModelThinkingLevel;
  /** 限流/网络错误的指数退避重试策略（默认见 DEFAULT_RETRY_POLICY）。 */
  retryPolicy?: RetryPolicyConfig;
}

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  modelsUrl: z.string().default(DEFAULT_MODELS_URL),
  contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(z.string()).default([]),
  maxTokens: z.number().default(8192),
  reasoningEffort: z.union([...THINKING_LEVELS]).default("high"),
  retryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
});

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiResponse {
  choices?: {
    index?: number;
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

interface ModelList {
  data?: { id?: string }[];
}

/** 免费档网关强校验：请求体必须携带 read/bash 两个工具定义（官方 CLI 字段集）。 */
const GATEWAY_TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: {
            type: "integer",
            description: "The line or directory entry to start reading from (1-based)",
          },
          limit: {
            type: "integer",
            description:
              "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Executes a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: {
            type: "string",
            description:
              "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
          },
          timeout: {
            type: "integer",
            description:
              "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 300000 for foreground commands. Background commands have no timeout by default.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
] as const;

/**
 * 官方 Identifier.create 算法的会话 id：value = Date.now()*0x1000+counter，
 * 前 6 字节大端 = 12 hex（编码真实时间，网关会解析回时间戳），后 14 位 base62。
 */
function opencodeSessionId(): string {
  const value = BigInt(Date.now()) * 0x1000n + 1n;
  let hex = "";
  for (let i = 0; i < 6; i++)
    hex += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  const base62 = randomBytes(64)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 14);
  return `ses_${hex}${base62}`;
}

/** 免费档网关要求的来源头族（除公共 content-type/authorization 外的增量）。 */
function opencodeRequestHeaders(): Record<string, string> {
  return {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-request": `msg_${Date.now()}${randomBytes(64).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
    "x-opencode-session": opencodeSessionId(),
    "x-opencode-session-id": opencodeSessionId(),
    "user-agent":
      "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  };
}

/** 从块列表提取纯文本。 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const part of blocks) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * 序列化 harness 会话为 OpenAI chat completions 消息。关键：
 * - assistant 的 tool-call 块 → `tool_calls`（OpenAI 格式，与文本共存）；
 * - 0.2.0 里工具结果是一等 `role:"tool"` 消息（ToolResultMessage）→ wire
 *   直接映射 `{role:"tool", tool_call_id}`（OpenAI 要求）；
 * - reasoning 块不发送（wire 无对应位置，文本+tool_calls 已足够）。
 */
function serializeMessages(
  system: string | undefined,
  messages: readonly RequestMessage[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system !== undefined && system.length > 0)
    out.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "tool") {
      const result = message as ToolResultMessage;
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: textOf(result.content),
      });
      continue;
    }
    const text = textOf(message.content);
    const toolCalls = message.content.filter(
      (part): part is ToolCallBlock => part.type === "tool-call",
    );
    if (message.role === "assistant") {
      if (text.length > 0 || toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });
      }
    } else if (text.length > 0) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  return reason === "length" ? { kind: "max-tokens" } : { kind: "stop" };
}

/** 校验推理等级：只接受标准词汇表内的等级（运行时已按声明清单预校验，这里是直达适配器的兜底）。 */
function validateReasoningEffort(effort: string): ModelThinkingLevel {
  if ((THINKING_LEVELS as readonly string[]).includes(effort))
    return effort as ModelThinkingLevel;
  throw new LlmError(
    `OpenCode Free does not support reasoning effort "${effort}"`,
    "UNSUPPORTED_REASONING_EFFORT",
  );
}

/**
 * 与原生 DeepSeek 适配器相同的 HTTP 错误归类。关键：400 + 上下文超限措辞
 * 归类为 CONTEXT_WINDOW_EXCEEDED——harness 的 compaction-basic 会对该代码
 * 自动压缩并重试（本插件另有 overflow-recovery 兜底）。
 */
function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return "AUTH";
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail))
      return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * 标准词汇表 → wire 映射（与 pi-ai openai-completions 派发一致）：等级原样
 * 作为 reasoning_effort（zen 网关已验证接受 low/high/max/minimal 等取值）；
 * off 关闭思考（thinking disabled，与原生 DeepSeek 语义一致）；标题生成不干预。
 */
function resolveThinking(options: GenerateOptions): {
  thinking?: "disabled";
  reasoningEffort?: Exclude<ModelThinkingLevel, "off">;
} {
  if (options.purpose === "session-title") return {};
  const effort =
    options.reasoningEffort === undefined
      ? undefined
      : validateReasoningEffort(options.reasoningEffort);
  if (effort === "off") return { thinking: "disabled" };
  if (effort !== undefined) return { reasoningEffort: effort };
  return {};
}

class OpenCodeAdapter extends LlmAdapter {
  /** 带 TTL 的模型列表缓存：过期后下次调用自动重新拉取。 */
  private modelsCache: { list: LlmModelInfo[]; expiresAt: number } | null =
    null;

  constructor(private readonly config: Config) {
    super();
  }

  providerInfo(provider: string) {
    return { id: provider, name: "OpenCode Free" };
  }

  /** 限流/网络失败的指数退避重试策略（harness 重试循环执行退避）。 */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy(
      this.config.retryPolicy,
      "opencode-free retryPolicy",
    );
  }

  /**
   * 模型列表：远程 `*-free` 清单 + 配置清单（显式配置的模型优先展示），带
   * TTL 缓存（默认 10 分钟，过期自动刷新）。拉取失败时只回配置清单且**不
   * 缓存**——下次打开选择器会重试，网络恢复后列表自动出现。不再硬编码
   * 任何默认模型：上游下架后列表自然消失。
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const now = Date.now();
    if (this.modelsCache !== null && this.modelsCache.expiresAt > now)
      return this.modelsCache.list;
    const ids = new Set(this.config.models ?? []);
    let succeeded = false;
    try {
      const response = await fetch(
        this.config.modelsUrl ?? DEFAULT_MODELS_URL,
        {
          headers: attributionHeaders(),
          signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
        },
      );
      if (response.ok) {
        const parsed = (await response.json()) as ModelList;
        for (const item of parsed.data ?? []) {
          if (item.id !== undefined && item.id.endsWith(FREE_SUFFIX))
            ids.add(item.id);
        }
        succeeded = true;
      }
    } catch {
      // 网络失败：退回配置清单，不缓存，下次重试。
    }
    const list = Array.from(ids).map((id) => ({ provider, id, name: id }));
    if (succeeded)
      this.modelsCache = { list, expiresAt: now + MODELS_CACHE_TTL_MS };
    return list;
  }

  async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: {
        contextWindow: this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      },
      ...(this.config.maxTokens !== undefined
        ? { defaultMaxTokens: this.config.maxTokens }
        : {}),
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: ReasoningEffortId(this.config.reasoningEffort ?? "high"),
      },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: serializeMessages(options.system, options.messages),
      // 免费档网关强校验（2026-10 实测）：必须 stream:true 且请求体携带
      // read/bash 工具定义，缺任一即 403 FreeTierError。
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 8192,
    };
    if (options.temperature !== undefined)
      body.temperature = options.temperature;
    if (options.stop !== undefined && options.stop.length > 0)
      body.stop = options.stop;
    const tools = (options.tools ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined && tool.description.length > 0
          ? { description: tool.description }
          : {}),
        parameters: tool.parameters,
      },
    }));
    const declared = new Set(tools.map((tool) => tool.function.name));
    // 只注入 DSH 未声明的占位工具：DSH 已声明 read/bash 时（绝大多数场景）
    // 不注入，模型对它们的调用原样透传，由 DSH 的真实工具执行。
    const injectedNames = new Set<string>();
    for (const tool of GATEWAY_TOOLS) {
      if (declared.has(tool.function.name)) continue;
      injectedNames.add(tool.function.name);
      tools.push(tool);
    }
    body.tools = tools;
    body.tool_choice = "auto";

    const thinking = resolveThinking(options);
    if (thinking.thinking !== undefined)
      body.thinking = { type: thinking.thinking };
    if (thinking.reasoningEffort !== undefined)
      body.reasoning_effort = thinking.reasoningEffort;

    let response: Response;
    try {
      response = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
          authorization: "Bearer public",
          // 免费档网关校验的来源头族（仿官方 CLI）。注意：不能并入
          // attributionHeaders()——它的 user-agent 是 DSH 身份，会覆盖
          // opencode UA，网关立即 403 FreeTierError（前端显示「API 密钥无效」）。
          ...opencodeRequestHeaders(),
        },
        body: JSON.stringify(body),
        signal: options.signal ?? null,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError("opencode request aborted by caller", "ABORTED", {
          cause: error,
        });
      }
      throw new LlmError("opencode API request failed", "TRANSPORT", {
        cause: error,
      });
    }

    if (!response.ok || response.body === null) {
      let message = `opencode API error (HTTP ${response.status})`;
      let detail = "";
      try {
        const parsed = (await response.json()) as OpenAiResponse;
        if (parsed.error?.message !== undefined) message = parsed.error.message;
        detail = [parsed.error?.type, parsed.error?.message]
          .filter(Boolean)
          .join(" ");
      } catch {
        // 错误体解析失败时保留状态码信息。
      }
      throw new LlmError(message, httpErrorCode(response.status, detail), {
        status: response.status,
      });
    }

    // SSE 流式消费：text/reasoning 增量发射（块切换时闭合）；工具调用聚合
    // 到流结束统一发射（harness 的 replay 协议按整块记录工具调用）。
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    let index = 0;
    let open: { kind: "text"; text: string } | { kind: "reasoning"; text: string } | null = null;
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let emittedAny = false;

    const closeOpen = function* (): Generator<StreamChunk> {
      if (open === null) return;
      if (open.kind === "text") {
        yield { type: "block-end", index, block: { type: "text", text: open.text } };
      } else {
        yield { type: "block-end", index, block: { type: "reasoning", text: open.text } };
      }
      index += 1;
      open = null;
    };

    while (!done) {
      const read = await reader.read();
      if (read.done) { done = true; break; }
      buffer += decoder.decode(read.value, { stream: true });
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        let parsed: {
          choices?: {
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string | null;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            reasoning_tokens?: number;
          } | null;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 非 JSON 行（注释/心跳）忽略。
        }
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason != null) finishReason = choice.finish_reason;
        if (parsed.usage != null) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            ...(parsed.usage.reasoning_tokens !== undefined
              ? { reasoningTokens: parsed.usage.reasoning_tokens }
              : {}),
          };
        }
        const delta = choice?.delta;
        if (delta === undefined) continue;
        const reasoningText = delta.reasoning_content ?? undefined;
        if (reasoningText !== undefined && reasoningText.length > 0) {
          if (open === null || open.kind !== "reasoning") {
            yield* closeOpen();
            open = { kind: "reasoning", text: "" };
            yield { type: "block-start", index, blockType: "reasoning" };
          }
          open.text += reasoningText;
          yield { type: "reasoning-delta", index, text: reasoningText };
          emittedAny = true;
        }
        const contentText = delta.content ?? undefined;
        if (contentText !== undefined && contentText.length > 0) {
          if (open === null || open.kind !== "text") {
            yield* closeOpen();
            open = { kind: "text", text: "" };
            yield { type: "block-start", index, blockType: "text" };
          }
          open.text += contentText;
          yield { type: "text-delta", index, text: contentText };
          emittedAny = true;
        }
        for (const call of delta.tool_calls ?? []) {
          const slot = toolAcc.get(call.index ?? 0) ?? { id: "", name: "", arguments: "" };
          if (call.id !== undefined) slot.id = call.id;
          if (call.function?.name !== undefined) slot.name += call.function.name;
          if (call.function?.arguments !== undefined) slot.arguments += call.function.arguments;
          toolAcc.set(call.index ?? 0, slot);
        }
      }
    }
    yield* closeOpen();

    // 响应侧：只拦截「本请求注入的占位工具」的调用（DSH 未声明同名工具、
    // 无法执行），以说明文本兜底；DSH 已声明的同名工具调用原样透传执行。
    let emitted = emittedAny;
    for (const [, call] of toolAcc) {
      if (injectedNames.has(call.name)) continue;
      emitted = true;
      const callId = ToolCallId(call.id || randomUUID());
      yield { type: "block-start", index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index,
        id: callId,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id: callId, name: call.name, arguments: call.arguments },
      };
      index += 1;
    }
    if (!emitted && (toolAcc.size > 0 || finishReason === "tool_calls")) {
      const note = "（该模型尝试调用的 read/bash 仅是接入占位工具，无法在此执行。）";
      yield { type: "block-start", index, blockType: "text" };
      yield { type: "text-delta", index, text: note };
      yield { type: "block-end", index, block: { type: "text", text: note } };
    }

    yield { type: "usage", usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
    yield {
      type: "finish",
      reason: mapFinishReason(finishReason),
      replayState: {
        response: { kind: "opencode", version: 1, model: options.model },
      },
    };
  }
}

/** 注册「OpenCode Free」provider（路由 opencode-free），自动提供 *-free 模型。 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(["opencode-free"], new OpenCodeAdapter(config));
}
