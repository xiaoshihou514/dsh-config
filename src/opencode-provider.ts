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

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  RetryPolicySchema,
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
  type Message,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
  type StreamChunk,
  type TokenUsage,
  type ToolCallBlock,
  type ToolResultBlock,
} from "@deepseek-ai/dsh-llm";

export const name = "dsh-config-opencode";
export const inject = ["llm"];

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MODEL = "deepseek-v4-flash-free";
const FREE_SUFFIX = "-free";
const MODELS_FETCH_TIMEOUT_MS = 4_000;

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
  models: z.array(z.string()).default([DEFAULT_MODEL]),
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
 * - harness 里工具结果在 user 消息内（tool-result 块）→ wire 拆成独立
 *   `{role:"tool", tool_call_id}` 消息（OpenAI 要求，与原生 deepseek 适配器一致）；
 * - reasoning 块不发送（wire 无对应位置，文本+tool_calls 已足够）。
 */
function serializeMessages(
  system: string | undefined,
  messages: readonly Message[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system !== undefined && system.length > 0)
    out.push({ role: "system", content: system });
  for (const message of messages) {
    const text = textOf(message.content);
    const toolCalls = message.content.filter(
      (part): part is ToolCallBlock => part.type === "tool-call",
    );
    const toolResults = message.content.filter(
      (part): part is ToolResultBlock => part.type === "tool-result",
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
    } else {
      if (text.length > 0) out.push({ role: "user", content: text });
      for (const result of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: textOf(result.content),
        });
      }
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
  /** 会话生命周期缓存：第一次 listModels 后不再拉取。 */
  private modelsCache: LlmModelInfo[] | null = null;

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
   * 模型列表：成功结果会话生命周期缓存（只拉一次，之后秒回）；拉取带 4s
   * 超时。失败时返回配置清单（至少含默认模型）且**不缓存**——下次打开
   * 选择器会重试，网络恢复后列表自动出现。
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    if (this.modelsCache !== null) return this.modelsCache;
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
    if (succeeded) this.modelsCache = list;
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
      stream: false,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 8192,
    };
    if (options.temperature !== undefined)
      body.temperature = options.temperature;
    if (options.stop !== undefined && options.stop.length > 0)
      body.stop = options.stop;
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined && tool.description.length > 0
            ? { description: tool.description }
            : {}),
          parameters: tool.parameters,
        },
      }));
    }

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
          accept: "application/json",
          ...attributionHeaders(),
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

    if (!response.ok) {
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

    const parsed = (await response.json()) as OpenAiResponse;
    const choice = parsed.choices?.[0];
    const reasoning = choice?.message?.reasoning_content ?? undefined;
    const content = choice?.message?.content ?? undefined;
    const toolCalls = choice?.message?.tool_calls ?? [];

    let nextIndex = 0;
    if (reasoning !== undefined && reasoning.length > 0) {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: reasoning };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "reasoning", text: reasoning },
      };
      nextIndex = 1;
    }
    if (content !== undefined && content.length > 0) {
      yield { type: "block-start", index: nextIndex, blockType: "text" };
      yield { type: "text-delta", index: nextIndex, text: content };
      yield {
        type: "block-end",
        index: nextIndex,
        block: { type: "text", text: content },
      };
      nextIndex += 1;
    }
    for (const call of toolCalls) {
      const index = nextIndex;
      const callId = CallId(call.id);
      nextIndex += 1;
      yield {
        type: "block-start",
        index,
        blockType: "tool-call",
      };
      yield {
        type: "tool-call-delta",
        index,
        id: callId,
        name: call.function.name,
        argumentsDelta: call.function.arguments,
      };
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: callId,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      };
    }

    const usage: TokenUsage = {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      ...(parsed.usage?.reasoning_tokens !== undefined
        ? { reasoningTokens: parsed.usage.reasoning_tokens }
        : {}),
    };
    yield { type: "usage", usage };
    yield {
      type: "finish",
      reason: mapFinishReason(choice?.finish_reason),
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
